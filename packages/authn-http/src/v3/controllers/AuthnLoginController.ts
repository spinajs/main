import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import '../../register-schema.js';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Body, BotCheck, Get, HTTP_STATUS_CODE, Header, Ok, Post, Redirect, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { SessionIssuer } from '@spinajs/authn/contracts';

import { ClientContext } from '../../args/authn.js';
import { AuthnLoginBody } from '../../dto/login.js';
import { unauthenticated } from '../../policies/v3/errors.js';
import { DEFAULT_LOGOUT_CLEAR_SITE_DATA } from '../../schema.js';
import { OnInvalidInput } from '../../validation/answers.js';
import { IpThrottle } from '../../middleware/ip-throttle.js';
import { failedLogin, throttledLogin } from '../../validation/login.js';
import type { AuthnClientContext } from '../client.js';
import { NO_STORE, authnClearedSessionCookie } from '../responses.js';
import { runLogoutExtensions } from '../logout-extension.js';
import { answerFor, auditEnded, completeLogin, isNavigation, pendingAnswer, pendingSteps } from '../routes.js';

// Sec-Fetch-Mode values are a few characters; an Accept header is bounded by the header size limit alone.
const FETCH_MODE_HEADER = { type: 'string', maxLength: 64 } as const;
const ACCEPT_HEADER = { type: 'string', maxLength: 16384 } as const;

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
   * `{ MfaRequired: [steps], MfaEnrol: [steps to enrol first] }` with the pending session cookie. Any failure, a body
   * the schema refuses included: 401 with one body, plus Retry-After when throttled.
   * @returns {AuthnLoginAnswer} The principal summary, or the pending answer when MFA is required
   * @response 401 {AuthnFailure} The login failed (Retry-After when throttled)
   * @security []
   */
  @Post('login')
  @BotCheck('login')
  @IpThrottle('login', throttledLogin)
  @OnInvalidInput(failedLogin)
  public async login(@Body({ required: true }) body: AuthnLoginBody, @ClientContext() client: AuthnClientContext) {
    return completeLogin(this.Container, this.Sessions, this._cfg, client, { kind: 'password', login: body.login, password: body.password });
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
  public async logout(
    @ClientContext() client: AuthnClientContext,
    // Typed plain string, not string | undefined: a union reaches the route args as Object, and Object values are parsed as JSON.
    @Header('sec-fetch-mode', FETCH_MODE_HEADER) fetchMode: string,
    @Header('accept', ACCEPT_HEADER) accept: string,
    // AuthnLogoutExtension takes the request (authn-oidc reads the origin from it): the one handler with @Req (D12).
    @Req() req: Request,
  ) {
    const session = client.session;
    if (!session) throw unauthenticated('there is no session to end');
    await this.Sessions.revoke(session.handle);
    await auditEnded(this.Container, client, session, 'logout', 'logout');
    const redirect = await runLogoutExtensions(this.Container, session, req, this.Log);
    const directives = this.ClearSiteData;
    const options = {
      Coockies: [authnClearedSessionCookie(this._cfg)],
      Headers: directives.length > 0 ? [{ Name: 'Clear-Site-Data', Value: directives.map((d) => `"${d}"`).join(', ') }, NO_STORE] : [NO_STORE],
    };
    if (redirect === undefined) return new Ok(null, options);
    return isNavigation(fetchMode, accept) ? new Redirect(redirect, HTTP_STATUS_CODE.SEE_OTHER, options) : new Ok({ endSession: redirect }, options);
  }

  /**
   * Who am I
   * The principal summary with the whoami extensions. A pending session gets only `{ MfaRequired: [steps], MfaEnrol: [steps to enrol first] }`.
   * @returns {AuthnLoginAnswer} The principal summary, or the pending answer of a pending session
   * @security cookieAuth
   * @response 401 {AuthnError} No principal and no pending session
   */
  @Get('/')
  public async whoami(@ClientContext() client: AuthnClientContext) {
    const principal = client.principal;
    if (principal?.authenticated === true) return new Ok(await answerFor(this.Container, 'whoami', principal), { Headers: [NO_STORE] });
    const session = client.session;
    if (session?.handle.state === 'pending') {
      const steps = await pendingSteps(this.Container, session, this.MfaPolicyService);
      return new Ok(await pendingAnswer(this.Container, this.MfaPolicyService, session.identity, steps), { Headers: [NO_STORE] });
    }
    throw unauthenticated('this route needs an authenticated caller');
  }
}
