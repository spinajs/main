import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Del, Get, NotFound, Ok, Param, Policy } from '@spinajs/http';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { Hooks } from '@spinajs/hooks';
import { hookRefusalOf, runHookedAction } from '@spinajs/authn/hooks';

import { ClientContext } from '../../args/authn.js';
import { SESSION_HANDLE_PARAM } from '../../dto/sessions.js';
import { activeSessionOf } from '../../policies/v3/principal.js';
import { OnInvalidInput } from '../../validation/answers.js';
import type { AuthnClientContext } from '../client.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '../index.js';
import { NO_STORE, authnClearedSessionCookie, hookRefusedAnswer } from '../responses.js';
import { contextOf, publishAuthnEvent } from '../routes.js';
import '../../hooks.js';

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

  @Autoinject(Hooks)
  protected Hooks!: Hooks;

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
   * Ends the own session with that handle; ending the current one logs the caller out. 404 for any other handle; 403
   * `action_refused` with the hook's code when an `authn.sessions.revoke` hook refuses.
   * @response 403 {AuthnError} action_refused (with `code`) when an `authn.sessions.revoke` hook refuses
   * @response 404 {AuthnError} session_not_found
   * @security cookieAuth
   */
  @Del('sessions/:handle')
  @OnInvalidInput(sessionNotFound)
  public async revoke(@ClientContext() client: AuthnClientContext, @Param(SESSION_HANDLE_PARAM) handle: string) {
    const session = activeSessionOf(client);
    let ended: number;
    try {
      ended = await this.revoking(client, session.identity, handle, session.handle, async () => ((await this.Sessions.revokeHandle(session.identity, handle)) ? 1 : 0));
    } catch (err) {
      return this.refused(client, err, session.identity);
    }
    if (ended === 0) return sessionNotFound();
    await publishAuthnEvent(this.Container, client, { type: 'session.revoke', outcome: 'success', reason: 'owner', identity: { type: session.identity.type, id: session.identity.id }, session: handle });
    const current = handle === session.facts.sessionHandle;
    return new Ok(null, { Coockies: current ? [authnClearedSessionCookie(this._cfg)] : [], Headers: [NO_STORE] });
  }

  /**
   * Revoke every other session
   * Ends all own sessions but the current one. 403 `action_refused` with the hook's code when an `authn.sessions.revoke`
   * hook refuses.
   * @returns {AuthnSessionsRevoked} The count of ended sessions
   * @response 403 {AuthnError} action_refused (with `code`) when an `authn.sessions.revoke` hook refuses
   * @security cookieAuth
   */
  @Del('sessions')
  public async revokeOthers(@ClientContext() client: AuthnClientContext) {
    const session = activeSessionOf(client);
    let revoked: number;
    try {
      revoked = await this.revoking(client, session.identity, 'others', session.handle, () => this.Sessions.revokeAll(session.identity, { except: session.handle }));
    } catch (err) {
      return this.refused(client, err, session.identity);
    }
    await publishAuthnEvent(this.Container, client, { type: 'session.revoke', outcome: 'success', reason: 'owner_others', identity: { type: session.identity.type, id: session.identity.id }, data: { count: revoked } });
    return new Ok({ Revoked: revoked }, { Headers: [NO_STORE] });
  }

  protected revoking(client: AuthnClientContext, subject: IdentityRef, handle: string, current: SessionHandle, revoke: () => Promise<number>): Promise<number> {
    return runHookedAction(this.Hooks, 'authn.sessions.revoke', { subject: { type: subject.type, id: subject.id }, handle, ctx: contextOf(client, 'request', current) }, revoke, { mutable: [] });
  }

  protected async refused(client: AuthnClientContext, err: unknown, subject: IdentityRef) {
    const refusal = hookRefusalOf(err, 'authn.sessions.revoke');
    if (!refusal) throw err;
    await publishAuthnEvent(this.Container, client, { type: 'session.revoke', outcome: 'failure', reason: refusal.reason, identity: { type: subject.type, id: subject.id } });
    return hookRefusedAnswer(refusal.code);
  }
}
