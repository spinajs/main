import { BaseController, BasePath, Body, ForbiddenResponse, Get, Ok, Policy, Post, Unauthorized } from '@spinajs/http';
import { PasswordProvider, SessionProvider, User as UserModel, regenerateSession } from '@spinajs/rbac';
import type { ISession } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { AuthorizedPolicy, IEnable2faResponse, Permission, Resource, Session as SessionRouteArg, TwoFactorAuthConfig, User } from '@spinajs/rbac-http';
import { BadRequest, Forbidden } from '@spinajs/exceptions';
import { ConfirmPasswordDto } from '../dto/confirm-password-dto.js';
import { TokenDto } from '../dto/token-dto.js';
import { SessionCookieFactory } from '../services/SessionCookies.js';
import { beginUser2FaEnrolment, confirmUser2Fa, disableUser2Fa } from '../actions/2fa.js';
import { TWO_FA_METATADATA_KEYS } from '../2fa/Default2FaToken.js';
import { TwoFactorAuthEnabled } from '../policies/2FaPolicy.js';

/** Whether the authenticated user currently has a TOTP device enrolled. */
export interface ITwoFactorStatus {
  Enabled: boolean;

  /**
   * A secret was issued but never confirmed. The account is not protected — the
   * distinction exists so the UI can say "you started this" rather than
   * "you have no 2fa".
   */
  Pending: boolean;

  /**
   * Whether 2FA is switched on system-wide (`rbac.twoFactorAuth.enabled`). The
   * frontend hides its 2FA controls when this is false; it is reported here
   * rather than signalled by an error because the guarding policy cannot
   * reject an authorized caller.
   */
  SystemEnabled: boolean;
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
 * `TwoFactorAuthEnabled` stays on the class as the guard for callers it is
 * able to reject, but it cannot block an authorized caller here:
 * `@spinajs/http` merges every policy on a route into ONE gate that lets the
 * route run when ANY policy resolves, and `AuthorizedPolicy` below resolves
 * for any logged-in caller — so once a session is authorized, that policy
 * alone is enough to pass the gate regardless of what `TwoFactorAuthEnabled`
 * decides. That is why the system-wide switch (`rbac.twoFactorAuth.enabled`)
 * is *also* enforced directly in the mutating handlers, via
 * {@link assertSystemEnabled}, which is the check that actually matters for
 * an authorized caller.
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

  @Config('rbac.twoFactorAuth')
  protected TwoFactorConfig: TwoFactorAuthConfig;

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
    const enabled = Boolean(user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED]);

    return new Ok({
      Enabled: enabled,
      Pending: !enabled && Boolean(user.Metadata[TWO_FA_METATADATA_KEYS.TOKEN]),
      SystemEnabled: this.TwoFactorConfig?.enabled !== false,
    });
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
    this.assertSystemEnabled();

    if (user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED]) {
      throw new BadRequest(`User ${user.Uuid} already has 2fa enabled`);
    }

    const confirmed = await this.confirmPassword(user, confirmation.Password);
    if (confirmed !== true) {
      return confirmed;
    }

    // The secret is stored but 2fa stays OFF until `POST /user/2fa/confirm`
    // accepts a code generated from it. A user who never scans is left pending,
    // which the login check treats exactly like having no device — no lockout,
    // and the next attempt simply issues a new secret.
    const result = await this.enrol(user);

    return new Ok({ otp: result as string }, await this.rotate(session));
  }

  /**
   * Confirm own two-factor enrolment
   * Verifies a code generated from the secret handed out by `POST /user/2fa/enable`
   * or `POST /user/2fa/reset`, and only then switches 2FA on.
   * @security cookieAuth
   * @response 200 Two-factor authentication is now active
   * @response 400 There is no pending enrolment to confirm
   * @response 401 Unauthorized — valid session required
   * @response 403 Invalid or expired TOTP code
   */
  @Post('2fa/confirm')
  @Permission(['updateOwn'])
  public async confirm(@User() user: UserModel, @Body() token: TokenDto, @SessionRouteArg() session: ISession): Promise<Ok | ForbiddenResponse> {
    this.assertSystemEnabled();

    // `activate()` never clears the stored token, so an already-enabled
    // account still has one and would otherwise be able to call this route
    // again with a currently-valid code. Only the pending state — a token
    // without 2fa being enabled yet — is an enrolment left to confirm.
    if (user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED] || !user.Metadata[TWO_FA_METATADATA_KEYS.TOKEN]) {
      throw new BadRequest(`User ${user.Uuid} has no pending 2fa enrolment`);
    }

    try {
      await this.confirmEnrolment(user, token.Token);
    } catch (err) {
      this._log.warn(`2fa confirmation rejected for ${user.Uuid}`, { error: err });

      return new ForbiddenResponse({
        error: { code: 'E_2FA_FAILED', message: '2fa check failed' },
      });
    }

    // No password here on purpose: the password was confirmed by the enable or
    // reset call that issued this secret, and the code is itself the proof this
    // route exists to demand.
    return new Ok(null, await this.rotate(session));
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
    this.assertSystemEnabled();

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
   * Reset own two-factor authentication
   * Removes the current TOTP device and issues a new secret in a single request,
   * returning the provisioning URI to scan. 2FA stays off until the new code is
   * confirmed with `POST /user/2fa/confirm`. Requires the account password.
   *
   * Folding disable-then-enable into one request removes the client-side gap
   * where abandoning the flow between the two calls could strand the account
   * without a second factor. It does not remove the server-side one: if
   * `enrol` fails after `unenrol` already removed the old device, the account
   * is left with no device at all — there is nothing to roll back to, since
   * the old secret is already gone. That leaves the account in the ordinary
   * `none` state, which every route here already handles: `GET /user/2fa`
   * reports it and `POST /user/2fa/enable` starts a fresh enrolment.
   * @security cookieAuth
   * @returns {IEnable2faResponse} OTP provisioning URI to scan with an authenticator app
   * @response 400 There is no two-factor device to reset
   * @response 401 Unauthorized — valid session required, or password invalid
   * @response 403 Forbidden — insufficient permissions
   */
  @Post('2fa/reset')
  @Permission(['updateOwn'])
  public async reset(@User() user: UserModel, @Body() confirmation: ConfirmPasswordDto, @SessionRouteArg() session: ISession): Promise<Ok<IEnable2faResponse> | Unauthorized> {
    this.assertSystemEnabled();

    if (!user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED] && !user.Metadata[TWO_FA_METATADATA_KEYS.TOKEN]) {
      throw new BadRequest(`User ${user.Uuid} has no 2fa to reset`);
    }

    const confirmed = await this.confirmPassword(user, confirmation.Password);
    if (confirmed !== true) {
      return confirmed;
    }

    await this.unenrol(user);
    const result = await this.enrol(user);

    return new Ok({ otp: result as string }, await this.rotate(session));
  }

  /**
   * Refuse a mutation while 2FA is switched off system-wide.
   *
   * The `TwoFactorAuthEnabled` policy cannot do this job: @spinajs/http merges
   * a route's policies into one gate that passes when ANY of them resolves, and
   * these routes also carry AuthorizedPolicy, which succeeds for every
   * logged-in caller. The check has to live where it cannot be short-circuited.
   */
  protected assertSystemEnabled(): void {
    if (this.TwoFactorConfig?.enabled === false) {
      throw Object.assign(new Forbidden('2 factor auth is not enabled'), {
        error: { code: 'E_2FA_SYSTEM_DISABLED', message: '2 factor auth is not enabled' },
      });
    }
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
   * Store the TOTP secret and return the provisioning URI, leaving 2fa off until
   * confirmed. Wraps the module-level action so tests can stub it without a
   * TOTP/DB setup.
   */
  protected enrol(user: UserModel): Promise<unknown> {
    return beginUser2FaEnrolment(user);
  }

  /** Verify a code against the pending secret and switch 2fa on. */
  protected confirmEnrolment(user: UserModel, token: string): Promise<unknown> {
    return confirmUser2Fa(user, token);
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
