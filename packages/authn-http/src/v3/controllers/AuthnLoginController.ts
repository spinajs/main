import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { SessionIssuer } from '@spinajs/authn/contracts';

import { unauthenticated } from '../../policies/v3/errors.js';
import { PASSWORD_HARD_CAP } from '../../policies/v3/fresh-auth.js';
import { NO_STORE, authnClearedSessionCookie } from '../responses.js';
import { answerFor, auditEnded, bodyField, boundedString, completeLogin, pendingSteps } from '../routes.js';

/**
 * Login, logout and whoami of the 3.0 layer (design §22.4, §22.11). Every failed login answers the same 401 body
 * (A02); a pending (pre-MFA) session answers only `MfaRequired` (SR-07).
 * @tags Authentication
 */
@BasePath('auth')
export class AuthnLoginController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(SessionIssuer)
  protected Sessions!: SessionIssuer;

  @Config('authn.mfa.policy.service')
  protected MfaPolicyService: string;

  /**
   * Login
   * Body `{ login, password }`. Ends a session the caller already holds. Success: the session cookie and the principal summary with the login extensions. MFA required: 200
   * `{ MfaRequired: [steps] }` with the pending session cookie. Any failure: 401 with one body, plus Retry-After when
   * throttled.
   * @security []
   */
  @Post('login')
  public async login(@Req() req: Request) {
    // Over-long values never verify (N3), so they reach no strategy, no throttle and no log.
    const login = boundedString(bodyField(req, 'login'), PASSWORD_HARD_CAP);
    const password = boundedString(bodyField(req, 'password'), PASSWORD_HARD_CAP);
    return completeLogin(this.Container, this.Sessions, this._cfg, req, login === null || password === null ? null : { kind: 'password', login, password });
  }

  /**
   * Logout
   * Ends the session of the cookie, pending ones included (an impersonation ends with it), and clears the cookie and
   * the site data. Audited as `logout`, and as `impersonation.end` (reason `logout`) for an impersonation (A20, A21).
   * POST, so no cross-site link can log anyone out.
   * @security cookieAuth
   * @response 401 No session
   */
  @Post('logout')
  public async logout(@Req() req: Request) {
    const session = req.storage.AuthnSession;
    if (!session) throw unauthenticated('there is no session to end');
    await this.Sessions.revoke(session.handle);
    await auditEnded(this.Container, req, session, 'logout', 'logout');
    return new Ok(null, {
      Coockies: [authnClearedSessionCookie(this._cfg)],
      Headers: [{ Name: 'Clear-Site-Data', Value: '"cache", "cookies", "storage"' }, NO_STORE],
    });
  }

  /**
   * Who am I
   * The principal summary with the whoami extensions. A pending session gets only `{ MfaRequired: [steps] }`.
   * @security cookieAuth
   * @response 401 No principal and no pending session
   */
  @Get('/')
  public async whoami(@Req() req: Request) {
    const principal = req.storage.AuthnPrincipal;
    if (principal?.authenticated === true) return new Ok(await answerFor(this.Container, 'whoami', principal), { Headers: [NO_STORE] });
    const session = req.storage.AuthnSession;
    if (session?.handle.state === 'pending') return new Ok({ MfaRequired: await pendingSteps(this.Container, session, this.MfaPolicyService) }, { Headers: [NO_STORE] });
    throw unauthenticated('this route needs an authenticated caller');
  }
}
