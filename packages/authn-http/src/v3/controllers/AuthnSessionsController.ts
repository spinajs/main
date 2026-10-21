import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Del, Get, NotFound, Ok, Param, Policy } from '@spinajs/http';
import { SessionIssuer } from '@spinajs/authn/contracts';

import { ClientContext } from '../../args/authn.js';
import { SESSION_HANDLE_PARAM } from '../../dto/sessions.js';
import { activeSessionOf } from '../../policies/v3/principal.js';
import { OnInvalidInput } from '../../validation/answers.js';
import type { AuthnClientContext } from '../client.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '../index.js';
import { NO_STORE, authnClearedSessionCookie } from '../responses.js';
import { publishAuthnEvent } from '../routes.js';

const sessionNotFound = (): NotFound => new NotFound({ error: 'session_not_found', message: 'No such session' });

/**
 * The caller's own sessions: list them, end one, end all others (A08; design §22.11). Needs a session principal; a
 * per-request credential has no session to manage. Rows carry the issuer's one-way handle, never an id or storage key.
 * Refused while impersonating: the impersonator acts as the target and must neither see the target's devices nor end
 * its sessions. The target, in its own list, sees the impersonation session (N2).
 * @tags Sessions
 */
@BasePath('user')
@Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
export class AuthnSessionsController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(SessionIssuer)
  protected Sessions!: SessionIssuer;

  /**
   * List own sessions
   * Newest first; `Current` marks the one making the request. Sessions in which someone impersonates the caller are
   * listed too, with the impersonator's ip and user agent.
   * @returns {AuthnSessionEntry[]} The own sessions, newest first
   * @security cookieAuth
   */
  @Get('sessions')
  public async list(@ClientContext() client: AuthnClientContext) {
    const session = activeSessionOf(client);
    const rows = await this.Sessions.list(session.identity, { current: session.handle });
    const entries = [...rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({
        Handle: r.handle,
        Created: r.createdAt.toISOString(),
        LastSeen: r.lastSeenAt.toISOString(),
        ...(r.ip !== undefined ? { Ip: r.ip } : {}),
        ...(r.userAgent !== undefined ? { UserAgent: r.userAgent } : {}),
        Current: r.current === true,
      }));
    return new Ok(entries, { Headers: [NO_STORE] });
  }

  /**
   * Revoke one session
   * Ends the own session with that handle; ending the current one logs the caller out. 404 for any other handle.
   * @response 404 {AuthnError} session_not_found
   * @security cookieAuth
   */
  @Del('sessions/:handle')
  @OnInvalidInput(sessionNotFound)
  public async revoke(@ClientContext() client: AuthnClientContext, @Param(SESSION_HANDLE_PARAM) handle: string) {
    const session = activeSessionOf(client);
    const ended = await this.Sessions.revokeHandle(session.identity, handle);
    if (!ended) return sessionNotFound();
    await publishAuthnEvent(this.Container, client, { type: 'session.revoke', outcome: 'success', reason: 'owner', identity: { type: session.identity.type, id: session.identity.id }, session: handle });
    const current = handle === session.facts.sessionHandle;
    return new Ok(null, { Coockies: current ? [authnClearedSessionCookie(this._cfg)] : [], Headers: [NO_STORE] });
  }

  /**
   * Revoke every other session
   * Ends all own sessions but the current one.
   * @returns {AuthnSessionsRevoked} The count of ended sessions
   * @security cookieAuth
   */
  @Del('sessions')
  public async revokeOthers(@ClientContext() client: AuthnClientContext) {
    const session = activeSessionOf(client);
    const revoked = await this.Sessions.revokeAll(session.identity, { except: session.handle });
    await publishAuthnEvent(this.Container, client, { type: 'session.revoke', outcome: 'success', reason: 'owner_others', identity: { type: session.identity.type, id: session.identity.id }, data: { count: revoked } });
    return new Ok({ Revoked: revoked }, { Headers: [NO_STORE] });
  }
}
