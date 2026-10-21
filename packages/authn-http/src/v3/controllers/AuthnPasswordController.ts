import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok, Patch, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { PasswordService } from '@spinajs/authn/contracts';

import { PasswordServiceRegistered, loginField, newPasswordField, oldPasswordField, passwordRejected, resetAck, resetRequestThrottled, secretField } from '../../password/index.js';
import { activeSessionOf } from '../../policies/v3/principal.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy, PASSWORD_HARD_CAP } from '../index.js';
import { NO_STORE, authnFailureResponse, authnSessionCookie, badRequest } from '../responses.js';
import { contextOf } from '../routes.js';

/**
 * Password routes of the 3.0 layer over the PasswordService contract (design §22.7, §22.11; A04, A11, A30, A32). Off
 * (404) while no PasswordService is registered. Body fields:
 *
 * - reset request: `login`;
 * - reset: `login`, `secret`, `password`, optional `confirmPassword`;
 * - change: `oldPassword`, `password`, optional `confirmPassword`.
 *
 * Every authentication failure (a wrong, used or expired secret, an unknown login, a wrong old password) answers the
 * login failure body (A02). A throttled reset redemption adds Retry-After as a throttled login does: its key is the
 * client ip alone, so the header tells nothing about an account. A throttled change sends none, as no
 * re-authentication does (A13, N3).
 * @tags Authentication
 */
@BasePath('/')
@Policy(PasswordServiceRegistered)
export class AuthnPasswordController extends BaseController {
  @Autoinject(PasswordService, { optional: true })
  protected Passwords: PasswordService | undefined;

  /**
   * Password policy
   * What every new password must satisfy: `minLength`, `maxLength`, and `pattern` and `description` when a rule is
   * configured. Public: the reset flow needs it before there is a session.
   * @returns {AuthnPasswordPolicy} The rules a new password must satisfy
   * @security []
   */
  @Get('auth/password/policy')
  public async policy() {
    return new Ok({ ...this.Passwords!.policy() });
  }

  /**
   * Request a password reset
   * Body `{ login }`. Answers at once with `{ Ok: true }`, whether or not the account exists and whether or not the
   * mail goes out (A11, SR-04); the secret travels only in the mail. 429 with Retry-After when throttled (per login
   * and per client ip), 400 `invalid_login` without a login.
   * @body {AuthnPasswordResetRequestBody} The login
   * @returns {AuthnOk} Always { Ok: true }
   * @response 400 {AuthnError} invalid_login
   * @security []
   */
  @Post('auth/password/reset-request')
  public async requestReset(@Req() req: Request) {
    const login = loginField(req);
    if (login === null) return badRequest('invalid_login', `login must be a non-empty string of at most ${PASSWORD_HARD_CAP} characters`);
    try {
      const result = await this.Passwords!.requestReset(login, contextOf(req, 'login'));
      if (result.status === 'throttled') return resetRequestThrottled(result.retryAfterSeconds);
    } catch (err) {
      // The answer must not tell a failed lookup or mail from a sent one; the name only, as an error can carry the login.
      this._log.warn({ errorName: (err as Error)?.name ?? typeof err }, 'A password reset request failed: ${errorName}');
    }
    return resetAck();
  }

  /**
   * Reset the password
   * Body `{ login, secret, password, confirmPassword? }`. Redeems a reset secret, or an invite secret while the
   * account is invite-pending (A32), once, and sets the password; ends every session of the account. `{ Ok: true }`
   * on success; 400 `password_rejected` with `violations` before the secret is spent; 400 `password_mismatch` or
   * `invalid_password`; any other failure the login failure body (A02, A11).
   * @body {AuthnPasswordResetBody} The secret and the new password
   * @returns {AuthnOk} The password is set
   * @response 400 {AuthnError} password_rejected (with violations), password_mismatch or invalid_password
   * @response 401 {AuthnFailure} Any other failure
   * @security []
   */
  @Post('auth/password/reset')
  public async reset(@Req() req: Request) {
    const next = newPasswordField(req);
    if ('answer' in next) return next.answer;
    const login = loginField(req);
    const secret = secretField(req);
    if (login === null || secret === null) return authnFailureResponse();

    const result = await this.Passwords!.redeemReset(login, secret, next.password, contextOf(req, 'login'));
    switch (result.status) {
      case 'reset':
        return resetAck();
      case 'rejected':
        return passwordRejected(result.violations);
      case 'throttled':
        return authnFailureResponse(result.retryAfterSeconds);
      default:
        return authnFailureResponse();
    }
  }

  /**
   * Change the own password
   * Body `{ oldPassword, password, confirmPassword? }`. The old password is the fresh authentication, verified inline
   * and counted in the reauth throttle. Success: 200 with the rotated session cookie; every other session of the
   * account ends, API tokens stay (A30). 400 `password_rejected` with `violations`, `password_mismatch` or
   * `invalid_password`; a wrong old password or a throttled change: the login failure body without Retry-After. A
   * session only: 403 `session_required` for a token or key, 403 `impersonating` while impersonating.
   * @body {AuthnPasswordChangeBody} The old and the new password
   * @response 400 {AuthnError} password_rejected (with violations), password_mismatch or invalid_password
   * @response 401 {AuthnUnauthorized} No session, a wrong old password or a throttled change
   * @response 403 {AuthnError} session_required or impersonating
   * @security cookieAuth
   */
  @Patch('user/password')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async change(@Req() req: Request) {
    const session = activeSessionOf(req);
    const next = newPasswordField(req);
    if ('answer' in next) return next.answer;
    const old = oldPasswordField(req);
    if (old === null) return authnFailureResponse();

    const result = await this.Passwords!.change(session.identity, old, next.password, session.handle, contextOf(req, 'reauth', session.handle));
    switch (result.status) {
      case 'changed':
        return new Ok(null, { Coockies: [authnSessionCookie(this._cfg, result.session)], Headers: [NO_STORE] });
      case 'rejected':
        return passwordRejected(result.violations);
      default:
        return authnFailureResponse();
    }
  }
}
