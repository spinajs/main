import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, BotCheck, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { PasswordService, SessionIssuer } from '@spinajs/authn/contracts';

import { CodeLoginRegistered, loginField, tooManyRequests } from '../../password/index.js';
import { PASSWORD_HARD_CAP } from '../../policies/v3/fresh-auth.js';
import { AcceptedResponse, NO_STORE, badRequest } from '../responses.js';
import { bodyField, boundedString, completeLogin, contextOf } from '../routes.js';

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

  /**
   * Request a login code
   * Body `{ login }`. Answers 202 `{ Ok: true }` at once, whether or not the account exists and whether or not a mail goes
   * out; the code travels only in the mail. 429 with Retry-After when throttled (per login and per client ip), 400
   * `invalid_login` without a login.
   * @security []
   */
  @Post('auth/code/request')
  @BotCheck('code_request')
  public async request(@Req() req: Request) {
    const login = loginField(req);
    if (login === null) return badRequest('invalid_login', `login must be a non-empty string of at most ${PASSWORD_HARD_CAP} characters`);
    try {
      const result = await this.Passwords!.requestCode!(login, contextOf(req, 'request'));
      if (result.status === 'throttled') return tooManyRequests('too many code requests, try again later', result.retryAfterSeconds);
    } catch (err) {
      // The answer must not tell a failed lookup or mail from a sent one; the name only, as an error can carry the login.
      this._log.warn({ errorName: (err as Error)?.name ?? typeof err }, 'A login code request failed: ${errorName}');
    }
    return new AcceptedResponse({ ...ACK }, { Headers: [NO_STORE] });
  }

  /**
   * Log in with a code
   * Body `{ login, code }`. Ends a session the caller already holds. Success: the session cookie and the principal summary
   * with the login extensions. Any failure, a wrong or spent code included: 401 with the one login failure body, plus
   * Retry-After when throttled.
   * @security []
   */
  @Post('auth/code/login')
  public async login(@Req() req: Request) {
    const login = loginField(req);
    const code = boundedString(bodyField(req, 'code'), PASSWORD_HARD_CAP);
    return completeLogin(this.Container, this.Sessions, this._cfg, req, login === null || code === null ? null : { kind: 'email-code', login, code });
  }
}
