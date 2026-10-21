import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Del, Get, NotFound, Ok, Param, Policy, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { Hooks } from '@spinajs/hooks';

import { activeSessionOf } from '../../policies/v3/principal.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '../index.js';
import { NO_STORE, authnClearedSessionCookie, hookRefusalOf, hookRefusedAnswer } from '../responses.js';
import { contextOf, publishAuthnEvent } from '../routes.js';
import '../../hooks.js';
import { runHooked } from '../hooked.js';

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
  public async list(@Req() req: Request) {
    const session = activeSessionOf(req);
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
   * @response 404 {AuthnError} session_not_found
   * @security cookieAuth
   */
  @Del('sessions/:handle')
  public async revoke(@Req() req: Request, @Param() handle: string) {
    const session = activeSessionOf(req);
    if (typeof handle !== 'string') return new NotFound({ error: 'session_not_found', message: 'No such session' });
    let ended: number;
    try {
      ended = await this.revoking(req, session.identity, handle, session.handle, async () => ((await this.Sessions.revokeHandle(session.identity, handle)) ? 1 : 0));
    } catch (err) {
      return this.refused(req, err, session.identity);
    }
    if (ended === 0) return new NotFound({ error: 'session_not_found', message: 'No such session' });
    await publishAuthnEvent(this.Container, req, { type: 'session.revoke', outcome: 'success', reason: 'owner', identity: { type: session.identity.type, id: session.identity.id }, session: handle });
    const current = handle === session.facts.sessionHandle;
    return new Ok(null, { Coockies: current ? [authnClearedSessionCookie(this._cfg)] : [], Headers: [NO_STORE] });
  }

  /**
   * Revoke every other session
   * Ends all own sessions but the current one. 403 `action_refused` with the hook's code when an `authn.sessions.revoke`
   * hook refuses.
   * @returns {AuthnSessionsRevoked} The count of ended sessions
   * @security cookieAuth
   */
  @Del('sessions')
  public async revokeOthers(@Req() req: Request) {
    const session = activeSessionOf(req);
    let revoked: number;
    try {
      revoked = await this.revoking(req, session.identity, 'others', session.handle, () => this.Sessions.revokeAll(session.identity, { except: session.handle }));
    } catch (err) {
      return this.refused(req, err, session.identity);
    }
    await publishAuthnEvent(this.Container, req, { type: 'session.revoke', outcome: 'success', reason: 'owner_others', identity: { type: session.identity.type, id: session.identity.id }, data: { count: revoked } });
    return new Ok({ Revoked: revoked }, { Headers: [NO_STORE] });
  }

  protected revoking(req: Request, subject: IdentityRef, handle: string, current: SessionHandle, revoke: () => Promise<number>): Promise<number> {
    return runHooked(this.Hooks, 'authn.sessions.revoke', { subject: { type: subject.type, id: subject.id }, handle, ctx: contextOf(req, 'request', current) }, revoke, { mutable: [] });
  }

  protected async refused(req: Request, err: unknown, subject: IdentityRef) {
    const refusal = hookRefusalOf(err, 'authn.sessions.revoke');
    if (!refusal) throw err;
    await publishAuthnEvent(this.Container, req, { type: 'session.revoke', outcome: 'failure', reason: refusal.reason, identity: { type: subject.type, id: subject.id } });
    return hookRefusedAnswer(refusal.code);
  }
}
