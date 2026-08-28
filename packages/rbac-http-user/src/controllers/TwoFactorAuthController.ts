import { TokenDto } from './../dto/token-dto.js';
import { BaseController, BasePath, Ok, Post, ForbiddenResponse } from '@spinajs/http';
import { ISession, SessionProvider, User as UserModel, AccessControl, regenerateSession } from '@spinajs/rbac';
import { Session } from '@spinajs/rbac-http';
import { Body, Policy } from '@spinajs/http';
import _ from 'lodash';
import { TwoFacRouteEnabled } from '../policies/2FaPolicy.js';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
import { User, NotAuthorizedPolicy, IEnable2faResponse, IUserWithGrants, TwoFactorAuthConfig } from '@spinajs/rbac-http';
import { auth2Fa, activateUser2Fa, beginUser2FaEnrolment } from '../actions/2fa.js';
import { BadRequest } from '@spinajs/exceptions';
import { TWO_FA_METATADATA_KEYS } from '../2fa/Default2FaToken.js';
import { SessionCookieFactory } from '../services/SessionCookies.js';
import { activeRoleOf, buildUserWithGrants } from '../services/grants.js';

/**
 * Two-factor authentication during login.
 *
 * These routes serve the narrow window between a successful password check and
 * full authorization: the session is `Logged` but not `Authorized` and carries
 * the `TwoFactorAuth` marker. Both class policies are passed to one `@Policy`
 * call, so they are combined with AND and the window closes the moment
 * verification succeeds. `TwoFacRouteEnabled` also enforces the system-wide
 * switch, by way of the `TwoFactorAuthEnabled` it extends.
 *
 * Managing a TOTP device outside that window — enrolling for the first time, or
 * turning 2FA off — lives on {@link TwoFactorAuthUserController} under
 * `/user/2fa`, where the caller is fully authorized. Notably there is no
 * "disable" here on purpose: a session that has not yet proven possession of
 * the second factor must not be able to remove it, which would reduce the whole
 * scheme to the password alone.
 *
 * @tags Two-Factor Authentication
 */
@BasePath('auth')
@Policy([TwoFacRouteEnabled, NotAuthorizedPolicy])
export class TwoFactorAuthController extends BaseController {
  @AutoinjectService('rbac.session')
  protected SessionProvider: SessionProvider;

  @Autoinject(SessionCookieFactory)
  protected SessionCookies: SessionCookieFactory;

  @Autoinject(AccessControl)
  protected AC: AccessControl;

  @Config('rbac.twoFactorAuth')
  protected TwoFactorConfig: TwoFactorAuthConfig;

  /**
   * Set up two-factor authentication during login
   * Generates a TOTP secret for a user who must enrol before continuing — the state
   * signalled by `TwoFactorInitRequired` at login when `rbac.twoFactorAuth.forceUser`
   * is on. Returns the OTP provisioning URI to scan with an authenticator app; the
   * caller then confirms with `POST /auth/2fa/verify`.
   * @security cookieAuth
   * @returns {IEnable2faResponse} OTP provisioning URI to scan with an authenticator app
   * @response 400 Two-factor authentication is already enabled for this user
   * @response 401 Unauthorized — valid session required
   * @response 403 Session is not awaiting two-factor enrolment
   */
  @Post('2fa/setup')
  public async setup2fa(@User() user: UserModel): Promise<Ok<IEnable2faResponse>> {
    if (user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED]) {
      throw new BadRequest(`User ${user.Uuid} already has 2fa enabled`);
    }

    // Re-running setup on an account that already started enrolling is allowed:
    // it replaces an unconfirmed secret, which is exactly how a user who lost
    // the QR gets a new one. There is nothing to steal — the caller could reach
    // the same state from scratch.
    const result = await this.enrol(user);

    return new Ok({
      otp: result as string,
    });
  }

  /**
   * Verify TOTP token
   * Validates the provided TOTP token against the user's 2FA secret. On success, marks the session
   * as fully authorized and returns the user profile with RBAC grants — identical to a full login response.
   * @security cookieAuth
   * @returns {IUserWithGrants} User profile merged with RBAC grants on successful 2FA verification
   * @response 403 Invalid or expired TOTP token
   * @response 401 Unauthorized — valid session required
   */
  @Post('2fa/verify')
  public async verifyToken(@User() logged: UserModel, @Body() token: TokenDto, @Session() session: ISession): Promise<Ok<IUserWithGrants> | ForbiddenResponse> {
    try {
      await this.verifyTwoFactorToken(logged, token.Token);

      // A pending enrolment (secret stored, `2fa:enabled` unset) becomes real
      // here and nowhere else — this is the first moment the user has proven
      // possession of the device.
      if (!logged.Metadata[TWO_FA_METATADATA_KEYS.ENABLED]) {
        await this.activateEnrolment(logged);
      }

      // 2fa complete, mark as authorized
      // fron now on user is considered authorized
      session.Data.set('Authorized', true);
      session.Data.delete('TwoFactorAuth');

      // Privilege elevation (login -> authorized) — regenerate the session
      // id to defend against session fixation and reset the ssid cookie.
      const regenerated = await regenerateSession(this.SessionProvider, session);

      this._log.trace('User logged in, 2fa authorized', {
        Uuid: logged.Uuid,
      });

      // Mirror the login response shape: resolve grants for the session's
      // active role (falling back to the first role) and include ActiveRole,
      // instead of flattening every role with no ActiveRole reported.
      const activeRole = activeRoleOf(logged, session);

      return new Ok(buildUserWithGrants(logged, activeRole, this.AC), {
        Coockies: [this.SessionCookies.issue(regenerated)],
      });
    } catch (err) {
      if (err instanceof Error) {
        this._log.error(err, '2fa verification failed');
      } else {
        this._log.error('2fa verification failed', { error: err });
      }

      return new ForbiddenResponse({
        error: {
          code: 'E_2FA_FAILED',
          message: '2fa check failed',
        },
      });
    }
  }

  /**
   * Verifies the supplied TOTP token against the user's 2FA secret. Wraps the
   * module-level `auth2Fa` action in a protected method so tests can stub the
   * verification without a TOTP/DB setup.
   */
  protected async verifyTwoFactorToken(user: UserModel, token: string): Promise<void> {
    await auth2Fa(user, token);
  }

  /**
   * Store the TOTP secret without switching 2fa on. Wrapped in a protected
   * method for the same reason as {@link verifyTwoFactorToken}.
   */
  protected enrol(user: UserModel): Promise<unknown> {
    return beginUser2FaEnrolment(user);
  }

  /** Switch 2fa on for an account whose secret was just verified. */
  protected activateEnrolment(user: UserModel): Promise<unknown> {
    return activateUser2Fa(user);
  }

}
