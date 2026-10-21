import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import '../../register-schema.js';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Get, HTTP_STATUS_CODE, Ok, Post, Redirect, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { SessionIssuer } from '@spinajs/authn/contracts';

import { unauthenticated } from '../../policies/v3/errors.js';
import { PASSWORD_HARD_CAP } from '../../policies/v3/fresh-auth.js';
import { DEFAULT_LOGOUT_CLEAR_SITE_DATA } from '../../schema.js';
import { NO_STORE, authnClearedSessionCookie } from '../responses.js';
import { runLogoutExtensions } from '../logout-extension.js';
import { answerFor, auditEnded, bodyField, boundedString, completeLogin, isNavigation, pendingAnswer, pendingSteps } from '../routes.js';

/**
 * Login, logout and whoami of the 3.0 layer (design §22.4, §22.11). Every failed login answers the same 401 body
 * (A02); a pending (pre-MFA) session answers only `MfaRequired` and `MfaEnrol` (SR-07).
 * @tags Authentication
 */
@BasePath('auth')
export class AuthnLoginController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(SessionIssuer)
  protected Sessions!: SessionIssuer;

  @Logger('authn-http')
  protected Log!: Log;

  @Config('authn.mfa.policy.service')
  protected MfaPolicyService: string;

  @Config('authn.http.logout.clearSiteData', { defaultValue: DEFAULT_LOGOUT_CLEAR_SITE_DATA })
  protected ClearSiteData: readonly string[];

  /**
   * Login
   * Body `{ login, password }`. Ends a session the caller already holds. Success: the session cookie and the principal summary with the login extensions. MFA required: 200
   * `{ MfaRequired: [steps], MfaEnrol: [steps to enrol first] }` with the pending session cookie. Any failure: 401 with one
   * body, plus Retry-After when throttled.
   * @body {AuthnLoginBody} The credentials
   * @returns {AuthnLoginAnswer} The principal summary, or the pending answer when MFA is required
   * @response 401 {AuthnFailure} The login failed (Retry-After when throttled)
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
   * the site data of `authn.http.logout.clearSiteData` (default cache, cookies and storage). Audited as `logout`, and as
   * `impersonation.end` (reason `logout`) for an impersonation (A20, A21).
   * POST, so no cross-site link can log anyone out. After the revoke every AuthnLogoutExtension may name a redirect (an OIDC
   * provider's end_session_endpoint): a navigation request gets 303 to it, any other client 200 `{ endSession }`.
   * @security cookieAuth
   * @response 303 The session ended; continue at the extension's redirect
   * @response 401 {AuthnError} No session
   */
  @Post('logout')
  public async logout(@Req() req: Request) {
    const session = req.storage.AuthnSession;
    if (!session) throw unauthenticated('there is no session to end');
    await this.Sessions.revoke(session.handle);
    await auditEnded(this.Container, req, session, 'logout', 'logout');
    const redirect = await runLogoutExtensions(this.Container, session, req, this.Log);
    const directives = this.ClearSiteData;
    const options = {
      Coockies: [authnClearedSessionCookie(this._cfg)],
      Headers: directives.length > 0 ? [{ Name: 'Clear-Site-Data', Value: directives.map((d) => `"${d}"`).join(', ') }, NO_STORE] : [NO_STORE],
    };
    if (redirect === undefined) return new Ok(null, options);
    return isNavigation(req) ? new Redirect(redirect, HTTP_STATUS_CODE.SEE_OTHER, options) : new Ok({ endSession: redirect }, options);
  }

  /**
   * Who am I
   * The principal summary with the whoami extensions. A pending session gets only `{ MfaRequired: [steps], MfaEnrol: [steps to enrol first] }`.
   * @returns {AuthnLoginAnswer} The principal summary, or the pending answer of a pending session
   * @security cookieAuth
   * @response 401 {AuthnError} No principal and no pending session
   */
  @Get('/')
  public async whoami(@Req() req: Request) {
    const principal = req.storage.AuthnPrincipal;
    if (principal?.authenticated === true) return new Ok(await answerFor(this.Container, 'whoami', principal), { Headers: [NO_STORE] });
    const session = req.storage.AuthnSession;
    if (session?.handle.state === 'pending') {
      const steps = await pendingSteps(this.Container, session, this.MfaPolicyService);
      return new Ok(await pendingAnswer(this.Container, this.MfaPolicyService, session.identity, steps), { Headers: [NO_STORE] });
    }
    throw unauthenticated('this route needs an authenticated caller');
  }
}
