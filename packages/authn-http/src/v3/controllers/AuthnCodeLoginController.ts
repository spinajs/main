import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Body, BotCheck, Policy, Post } from '@spinajs/http';
import { PasswordService, SessionIssuer } from '@spinajs/authn/contracts';
import { Hooks } from '@spinajs/hooks';
import { hookRefusalOf, runHookedAction } from '@spinajs/authn/hooks';

import { ClientContext } from '../../args/authn.js';
import { AuthnCodeLoginBody, AuthnCodeRequestBody } from '../../dto/code-login.js';
import { CodeLoginRegistered, invalidLogin, tooManyRequests } from '../../password/index.js';
import { OnInvalidInput, byField, unknownField } from '../../validation/answers.js';
import { IpThrottle } from '../../middleware/ip-throttle.js';
import { failedLogin, throttledLogin } from '../../validation/login.js';
import type { AuthnClientContext } from '../client.js';
import { AcceptedResponse, NO_STORE } from '../responses.js';
import { completeLogin, contextOf, publishAuthnEvent } from '../routes.js';
import '../../hooks.js';

const ACK: Readonly<{ Ok: true }> = Object.freeze({ Ok: true });

/**
 * Login with a code mailed to the account's address, over the optional `requestCode` of the PasswordService and the
 * `email-code` strategy (FEAT-3, A36). Off (404) while the registered PasswordService sends no codes. A code login is a
 * single factor like a password: the session is aal1 and the MFA policy treats the method `email-code` as it lists it.
 * @tags Authentication
 */
@BasePath('/')
@Policy(CodeLoginRegistered)
export class AuthnCodeLoginController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(SessionIssuer)
  protected Sessions!: SessionIssuer;

  @Autoinject(PasswordService, { optional: true })
  protected Passwords: PasswordService | undefined;

  @Autoinject(Hooks)
  protected Hooks!: Hooks;

  /**
   * Request a login code
   * Body `{ login }`. Answers 202 `{ Ok: true }` at once, whether or not the account exists and whether or not a mail goes
   * out; the code travels only in the mail. 429 with Retry-After when throttled (per login and per client ip), 400
   * `invalid_login` without a login. An `authn.code.request` hook that refuses gets the same 202, and no mail goes out.
   * @response 202 {AuthnOk} Always { Ok: true }
   * @response 400 {AuthnError} invalid_login or invalid_field
   * @security []
   */
  @Post('auth/code/request')
  @BotCheck('code_request')
  @IpThrottle('reset', (retryAfter) => tooManyRequests('too many code requests, try again later', retryAfter))
  @OnInvalidInput(byField({ login: invalidLogin }, unknownField))
  public async request(@Body({ required: true }) body: AuthnCodeRequestBody, @ClientContext() client: AuthnClientContext) {
    const login = body.login;
    const ctx = contextOf(client, 'request');
    try {
      const result = await runHookedAction(this.Hooks, 'authn.code.request', { login, ctx }, () => this.Passwords!.requestCode!(login, ctx), { mutable: [] });
      if (result.status === 'throttled') return tooManyRequests('too many code requests, try again later', result.retryAfterSeconds);
    } catch (err) {
      const refusal = hookRefusalOf(err, 'authn.code.request');
      // The answer of any other login: only the audit tells.
      if (refusal) return this.refused(client, refusal.reason);
      // The answer must not tell a failed lookup or mail from a sent one; the name only, as an error can carry the login.
      this._log.warn({ errorName: (err as Error)?.name ?? typeof err }, 'A login code request failed: ${errorName}');
    }
    return new AcceptedResponse({ ...ACK }, { Headers: [NO_STORE] });
  }

  private async refused(client: AuthnClientContext, reason: string) {
    try {
      await publishAuthnEvent(this.Container, client, { type: 'code.request', outcome: 'failure', reason, data: { via: 'login' } });
    } catch (err) {
      this._log.warn({ errorName: (err as Error)?.name ?? typeof err }, 'A refused login code request could not be audited: ${errorName}');
    }
    return new AcceptedResponse({ ...ACK }, { Headers: [NO_STORE] });
  }

  /**
   * Log in with a code
   * Body `{ login, code }`. Ends a session the caller already holds. Success: the session cookie and the principal summary
   * with the login extensions. Any failure, a wrong or spent code included: 401 with the one login failure body, plus
   * Retry-After when throttled.
   * @returns {AuthnLoginAnswer} The principal summary, or the pending answer when MFA is required
   * @response 401 {AuthnFailure} The login failed (Retry-After when throttled)
   * @security []
   */
  @Post('auth/code/login')
  @IpThrottle('login', throttledLogin)
  @OnInvalidInput(failedLogin)
  public async login(@Body({ required: true }) body: AuthnCodeLoginBody, @ClientContext() client: AuthnClientContext) {
    return completeLogin(this.Container, this.Sessions, this._cfg, client, { kind: 'email-code', login: body.login, code: body.code });
  }
}
