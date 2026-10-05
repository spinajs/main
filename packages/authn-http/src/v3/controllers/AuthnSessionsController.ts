import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Del, Get, NotFound, Ok, Param, Policy, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { SessionIssuer } from '@spinajs/authn/contracts';

import { refused } from '../../policies/v3/errors.js';
import { Authenticated, NoTokenAuthPolicy } from '../index.js';
import { NO_STORE, authnClearedSessionCookie } from '../responses.js';
import type { Restored } from '../routes.js';

/**
 * The caller's own sessions: list them, end one, end all others (A08; design §22.11). Needs a session principal; a
 * per-request credential has no session to manage. Rows carry the issuer's one-way handle, never an id or storage key.
 * @tags Sessions
 */
@BasePath('user')
@Policy([Authenticated, NoTokenAuthPolicy])
export class AuthnSessionsController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * List own sessions
   * Newest first; `Current` marks the one making the request. Sessions in which someone impersonates the caller are
   * listed too, with the impersonator's ip and user agent.
   * @security cookieAuth
   */
  @Get('sessions')
  public async list(@Req() req: Request) {
    const session = this.own(req);
    const rows = await (await this.Container.resolve(SessionIssuer)).list(session.identity, { current: session.handle });
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
   * @security cookieAuth
   */
  @Del('sessions/:handle')
  public async revoke(@Req() req: Request, @Param() handle: string) {
    const session = this.own(req);
    const ended = typeof handle === 'string' && (await (await this.Container.resolve(SessionIssuer)).revokeHandle(session.identity, handle));
    if (!ended) return new NotFound({ error: 'session_not_found', message: 'No such session' });
    const current = handle === session.facts.sessionHandle;
    return new Ok(null, { Coockies: current ? [authnClearedSessionCookie(this._cfg)] : [], Headers: [NO_STORE] });
  }

  /**
   * Revoke every other session
   * Ends all own sessions but the current one.
   * @security cookieAuth
   */
  @Del('sessions')
  public async revokeOthers(@Req() req: Request) {
    const session = this.own(req);
    const revoked = await (await this.Container.resolve(SessionIssuer)).revokeAll(session.identity, { except: session.handle });
    return new Ok({ Revoked: revoked }, { Headers: [NO_STORE] });
  }

  protected own(req: Request): Restored {
    const session = req.storage.AuthnSession;
    if (session?.handle.state !== 'active') throw refused('session_required', 'this route needs a session');
    return session;
  }
}
