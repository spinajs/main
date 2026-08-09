import { BaseController, BasePath, Body, Get, Ok, Policy, Post, Unauthorized } from '@spinajs/http';
import { PasswordProvider, SessionProvider, User as UserModel, regenerateSession } from '@spinajs/rbac';
import type { ISession } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';
import { AuthorizedPolicy, IEnable2faResponse, Permission, Resource, Session as SessionRouteArg, User } from '@spinajs/rbac-http';
import { BadRequest } from '@spinajs/exceptions';
import { TwoFactorAuthEnabled } from '../policies/2FaPolicy.js';
import { ConfirmPasswordDto } from '../dto/confirm-password-dto.js';
import { SessionCookieFactory } from '../services/SessionCookies.js';
import { disableUser2Fa, enableUser2Fa } from '../actions/2fa.js';
import { TWO_FA_METATADATA_KEYS } from '../2fa/Default2FaToken.js';

/** Whether the authenticated user currently has a TOTP device enrolled. */
export interface ITwoFactorStatus {
  Enabled: boolean;
}

/**
 * Self-service two-factor authentication.
 *
 * Enrolling and unenrolling a TOTP device for one's own account, from a fully
 * authorized session. These operations were previously only reachable from the
 * login-time 2FA window, whose policies (`TwoFacRouteEnabled` +
 * `NotAuthorizedPolicy`) exclude an authorized session by construction — so a
 * normal logged-in user could neither enrol nor unenrol, and the only ways in
 * were the CLI command or an administrator's 2FA reset.
 *
 * Both mutations re-verify the account password. A stolen session cookie must
 * not be enough to attach an attacker-controlled authenticator or to strip the
 * second factor off the account.
 *
 * @tags Two-Factor Settings
 */
@BasePath('user')
@Resource('user')
@Policy(AuthorizedPolicy)
@Policy(TwoFactorAuthEnabled)
export class TwoFactorAuthUserController extends BaseController {
  @AutoinjectService('rbac.password')
  protected PasswordProvider: PasswordProvider;

  @AutoinjectService('rbac.session')
  protected SessionProvider: SessionProvider;

  @Autoinject(SessionCookieFactory)
  protected SessionCookies: SessionCookieFactory;

  /**
   * Get own two-factor status
   * Reports whether the authenticated user currently has a TOTP device enrolled.
   * @security cookieAuth
   * @returns {ITwoFactorStatus} Current enrolment state
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — insufficient permissions
   */
  @Get('2fa')
  @Permission(['readOwn'])
  public async status(@User() user: UserModel): Promise<Ok<ITwoFactorStatus>> {
    return new Ok({ Enabled: Boolean(user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED]) });
  }

  /**
   * Enable own two-factor authentication
   * Generates a TOTP secret for the authenticated user and returns the OTP provisioning
   * URI to scan with an authenticator app. Requires the account password to be re-entered.
   * @security cookieAuth
   * @returns {IEnable2faResponse} OTP provisioning URI to scan with an authenticator app
   * @response 400 Two-factor authentication is already enabled for this user
   * @response 401 Unauthorized — valid session required, or password invalid
   * @response 403 Forbidden — insufficient permissions
   */
  @Post('2fa/enable')
  @Permission(['updateOwn'])
  public async enable(@User() user: UserModel, @Body() confirmation: ConfirmPasswordDto, @SessionRouteArg() session: ISession): Promise<Ok<IEnable2faResponse> | Unauthorized> {
    if (user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED]) {
      throw new BadRequest(`User ${user.Uuid} already has 2fa enabled`);
    }

    const confirmed = await this.confirmPassword(user, confirmation.Password);
    if (confirmed !== true) {
      return confirmed;
    }

    // NOTE: enrolment takes effect immediately — the secret is stored and
    // `2fa:enabled` is set before the user has proven they scanned it. That is
    // the same contract the login-time setup route follows, and it is what the
    // login check reads. A user who never scans the returned URI locks
    // themselves out and needs an administrator 2FA reset to recover.
    const result = await this.enrol(user);

    return new Ok({ otp: result as string }, await this.rotate(session));
  }

  /**
   * Disable own two-factor authentication
   * Removes the TOTP secret and disables 2FA for the authenticated user.
   * Requires the account password to be re-entered.
   * @security cookieAuth
   * @response 200 Two-factor authentication disabled successfully
   * @response 400 Two-factor authentication is not enabled for this user
   * @response 401 Unauthorized — valid session required, or password invalid
   * @response 403 Forbidden — insufficient permissions
   */
  @Post('2fa/disable')
  @Permission(['updateOwn'])
  public async disable(@User() user: UserModel, @Body() confirmation: ConfirmPasswordDto, @SessionRouteArg() session: ISession): Promise<Ok | Unauthorized> {
    if (!user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED]) {
      throw new BadRequest(`User ${user.Uuid} already has 2fa disabled`);
    }

    const confirmed = await this.confirmPassword(user, confirmation.Password);
    if (confirmed !== true) {
      return confirmed;
    }

    await this.unenrol(user);
    return new Ok(null, await this.rotate(session));
  }

  /**
   * Rotates the session id after the account's authentication requirements
   * changed, and returns the response options carrying the new cookie.
   *
   * Attaching or removing a second factor changes what the session is worth. A
   * session id that was observed before the change must not keep working after
   * it.
   *
   * @param session - the caller's current session
   */
  protected async rotate(session: ISession) {
    if (!session) {
      return { Headers: [{ Name: 'Cache-Control', Value: 'no-store' }] };
    }

    const regenerated = await regenerateSession(this.SessionProvider, session);

    return {
      Coockies: [this.SessionCookies.issue(regenerated)],
      Headers: [{ Name: 'Cache-Control', Value: 'no-store' }],
    };
  }

  /**
   * Generate and store the TOTP secret, returning the provisioning URI. Wraps
   * the module-level action so tests can stub it without a TOTP/DB setup.
   */
  protected enrol(user: UserModel): Promise<unknown> {
    return enableUser2Fa(user);
  }

  /** Clear the TOTP secret. Wrapped for the same reason as {@link enrol}. */
  protected unenrol(user: UserModel): Promise<unknown> {
    return disableUser2Fa(user);
  }

  /**
   * Re-verify the account password. Returns `true` on success, or the
   * Unauthorized response to hand back to the caller.
   */
  protected async confirmPassword(user: UserModel, password: string): Promise<true | Unauthorized> {
    const valid = await this.PasswordProvider.verify(user.Password, password);

    if (!valid) {
      this._log.warn(`2fa change rejected for ${user.Uuid}: password confirmation failed`);

      return new Unauthorized({
        error: { code: 'E_PASSWORD_INVALID', message: 'Invalid password' },
      });
    }

    return true;
  }
}
