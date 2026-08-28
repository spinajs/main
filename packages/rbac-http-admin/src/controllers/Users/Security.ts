import { AutoinjectService } from '@spinajs/configuration';
import { BaseController, BasePath, Body, Del, Get, NotFound, Ok, Param, Patch, Policy, Post } from '@spinajs/http';
import { activate, ban, changeUserPassword, deactivate, expirePassword, hashSessionId, passwordChangeRequest, SessionProvider, unban, User, USER_COMMON_METADATA, userModel } from '@spinajs/rbac';
import type { ISession } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource, User as CurrentUser } from '@spinajs/rbac-http';
import { FromModel } from '@spinajs/orm-http';
import { Schema } from '@spinajs/validation';
import { disableUser2Fa, enableUser2Fa, resetUser2Fa } from '@spinajs/rbac-http-user';
import { Log, Logger } from '@spinajs/log';

import { RoleGuard } from '../../interfaces.js';

// Side effect only — see the note in Users.ts.
import '../../services/RoleGuard.js';

@Schema({
  type: 'object',
  $id: 'arrow.common.changePasswordDTO',
  properties: {
    password: { type: 'string', minLength: 8, maxLength: 128, description: 'New password (8–128 characters)' },
    confirmPassword: { type: 'string', minLength: 8, maxLength: 128, description: 'Must match password' },
  },
  required: ['password', 'confirmPassword'],
  allOf: [
    {
      if: {
        properties: {
          password: { type: 'string' },
          confirmPassword: { type: 'string' },
        },
      },
      then: {
        properties: {
          confirmPassword: { const: { $data: '1/password' } },
        },
      },
    },
  ],
})
export class ChangePasswordDto {
  public password: string;
  public confirmPassword: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

@Schema({
  type: 'object',
  $id: 'arrow.common.banUserDTO',
  properties: {
    reason: { type: 'string', maxLength: 255, description: 'Why the account is banned. Stored in user metadata.' },
    duration: { type: 'number', minimum: 1, description: 'Ban duration in seconds. Defaults to 24h.' },
  },
})
export class BanUserDto {
  public reason?: string;
  public duration?: number;

  constructor(data: Partial<BanUserDto>) {
    Object.assign(this, data);
  }
}

/** One live session of a user, as reported to an administrator. */
export interface IAdminSessionEntry {
  /**
   * Opaque handle for the session, NOT the session id — the id is a working
   * credential and an admin listing must not hand out the means to
   * impersonate the accounts it lists.
   */
  Handle: string;

  /** ISO instant the session was opened */
  Created: string;

  /** ISO instant the session expires, or null when it never does */
  Expires: string | null;
}

/**
 * User account security management (admin).
 * Administrative controls for user account security: passwords, 2FA, account
 * activation, bans, login lockouts and live sessions.
 *
 * Every route that takes an account out of service goes through the configured
 * {@link RoleGuard} first — an administrator must not be able to lock themselves,
 * or the installation, out through this API.
 * @tags Admin Users
 */
@BasePath('users/security')
@Policy(AuthorizedPolicy)
@Resource('users')
export class Security extends BaseController {
  @Logger('rbac-admin')
  protected Log: Log;

  @AutoinjectService('rbac.session')
  protected SessionProvider: SessionProvider;

  @AutoinjectService('rbac.admin.roleGuard')
  protected RoleGuard: RoleGuard;

  /**
   * Change user password (admin)
   * Sets a new password for the specified user. Both password and confirmPassword must match.
   * Minimum length is 8 characters. Every session of that user is destroyed — the credential
   * they were opened with no longer exists.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 Password changed successfully
   * @response 400 Passwords do not match or fail validation
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on users resource
   * @response 404 User not found
   */
  @Patch('changePassword/:user')
  @Permission(['updateAny', 'updateOwn'])
  public async changeUserPassword(@FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User, @Body() dto: ChangePasswordDto) {
    await changeUserPassword(user, dto.password);
    return new Ok();
  }

  /**
   * Send a password reset link (admin)
   * Issues a single-use reset token into the user's metadata and emits
   * `UserPasswordChangeRequest` so the application can deliver it. The token itself is never
   * returned. This is how a freshly created account is handed over to its owner — the
   * temporary password generated at creation is deliberately discarded.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 Reset token issued
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on users resource
   * @response 404 User not found
   */
  @Post('password-reset-request/:user')
  @Permission(['updateAny', 'updateOwn'])
  public async requestPasswordReset(@FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User) {
    await passwordChangeRequest(user);
    return new Ok();
  }

  /**
   * Expire a user password (admin)
   * Marks the password as expired, which deactivates the account until a new one is set.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 Password expired
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — deleteAny permission required, or refused by the role guard
   * @response 404 User not found
   */
  @Post('expire-password/:user')
  @Permission(['deleteAny', 'deleteOwn'])
  public async expireUserPassword(@CurrentUser() actor: User, @FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User) {
    // Expiry deactivates the account, so it is guarded like every other way
    // of taking an account out of service.
    await this.RoleGuard.assertCanDisableAccount(actor, user, 'deactivate');
    await expirePassword(user);

    return new Ok();
  }

  /**
   * Reset user two-factor authentication (admin)
   * Clears the TOTP secret and disables 2FA for the specified user.
   * Use this to help a user regain access when they lose their authenticator device.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 2FA reset successfully
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on users resource
   * @response 404 User not found
   */
  @Patch('reset2fa/:user')
  @Permission(['updateAny', 'updateOwn'])
  public async reset2faToken(@FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User) {
    await resetUser2Fa(user);
    return new Ok();
  }

  /**
   * Enable two-factor authentication for a user (admin)
   * Initializes a TOTP secret for the account. Returns whatever the configured
   * two-factor provider produces for enrolment (an otpauth url for the default provider) —
   * deliver it to the user over a channel you trust.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 2FA enabled
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on users resource
   * @response 404 User not found
   */
  @Post('2fa/enable/:user')
  @Permission(['updateAny', 'updateOwn'])
  public async enable2Fa(@FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User) {
    return new Ok(await enableUser2Fa(user));
  }

  /**
   * Disable two-factor authentication for a user (admin)
   * Removes the TOTP secret and turns the second factor off for the account.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 2FA disabled
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on users resource
   * @response 404 User not found
   */
  @Post('2fa/disable/:user')
  @Permission(['updateAny', 'updateOwn'])
  public async disable2Fa(@FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User) {
    await disableUser2Fa(user);
    return new Ok();
  }

  /**
   * Deactivate user account (admin)
   * Marks the user account as inactive and destroys its sessions, preventing login without
   * deleting the record.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 Account deactivated successfully
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — deleteAny permission required, or refused by the role guard
   * @response 404 User not found
   */
  @Post('deactivate/:user')
  @Permission(['deleteAny', 'deleteOwn'])
  public async deactivateUser(@CurrentUser() actor: User, @FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User) {
    await this.RoleGuard.assertCanDisableAccount(actor, user, 'deactivate');
    await deactivate(user);

    return new Ok();
  }

  /**
   * Activate user account (admin)
   * Marks a previously deactivated user account as active, restoring login access.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 Account activated successfully
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on users resource
   * @response 404 User not found
   */
  @Post('activate/:user')
  @Permission(['updateAny', 'updateOwn'])
  public async activateUser(@FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User) {
    await activate(user);
    return new Ok();
  }

  /**
   * Ban a user (admin)
   * Bans the account for `duration` seconds (24h when omitted), records the reason, and
   * destroys every session it holds.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 Account banned
   * @response 400 Account is already banned
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — deleteAny permission required, or refused by the role guard
   * @response 404 User not found
   */
  @Post('ban/:user')
  @Permission(['deleteAny', 'deleteOwn'])
  public async banUser(@CurrentUser() actor: User, @FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User, @Body() dto: BanUserDto) {
    await this.RoleGuard.assertCanDisableAccount(actor, user, 'ban');
    await ban(user, dto?.reason, dto?.duration);

    return new Ok();
  }

  /**
   * Unban a user (admin)
   * Clears the ban metadata from the account.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 Account unbanned
   * @response 400 Account is not banned
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on users resource
   * @response 404 User not found
   */
  @Post('unban/:user')
  @Permission(['updateAny', 'updateOwn'])
  public async unbanUser(@FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User) {
    await unban(user);
    return new Ok();
  }

  /**
   * Clear a login lockout (admin)
   * Removes the failed-attempt counter and the lockout window opened by the login throttle,
   * letting the user try again immediately. Without this the only remedy is waiting out
   * `rbac.password.lockoutTime`.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 Lockout cleared
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on users resource
   * @response 404 User not found
   */
  @Post('unlock/:user')
  @Permission(['updateAny', 'updateOwn'])
  public async unlockUser(@FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User) {
    await user.Metadata.delete(USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS);
    await user.Metadata.delete(USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL);

    this.Log.info(`Login lockout cleared`, { User: user.Uuid });

    return new Ok();
  }

  /**
   * List sessions of a user (admin)
   * Returns every live session of the account, newest first, identified by an opaque handle.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @returns {IAdminSessionEntry[]} Live sessions of the user
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on users resource
   * @response 404 User not found
   */
  @Get('sessions/:user')
  @Permission(['readAny', 'readOwn'])
  public async listSessions(@FromModel({ queryField: 'Uuid', model: () => userModel() }) user: User): Promise<Ok<IAdminSessionEntry[]>> {
    const sessions = await this.SessionProvider.listByUser(user.Id);

    const entries = sessions.map((s) => this.toEntry(s)).sort((a, b) => (a.Created < b.Created ? 1 : -1));

    return new Ok(entries, { Headers: [{ Name: 'Cache-Control', Value: 'no-store' }] });
  }

  /**
   * Revoke one session of a user (admin)
   * Ends a single session, addressed by the handle returned from the listing.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @param handle Session handle as returned by `GET /users/security/sessions/:user`
   * @response 200 Session revoked
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on users resource
   * @response 404 No such session for this user
   */
  @Del('sessions/:user/:handle')
  @Permission(['updateAny', 'updateOwn'])
  public async revokeSession(@FromModel({ queryField: 'Uuid', model: () => userModel() }) user: User, @Param() handle: string): Promise<Ok | NotFound> {
    // Resolved through THIS user's session list, so a handle belonging to
    // somebody else cannot be revoked through their uuid.
    const sessions = await this.SessionProvider.listByUser(user.Id);
    const match = sessions.find((s) => hashSessionId(s.SessionId) === handle);

    if (!match) {
      return new NotFound({ error: { code: 'E_SESSION_NOT_FOUND', message: 'No such session' } });
    }

    await this.SessionProvider.delete(match.SessionId);

    this.Log.info(`Session revoked by administrator`, { Session: handle, User: user.Uuid });

    return new Ok(null, { Headers: [{ Name: 'Cache-Control', Value: 'no-store' }] });
  }

  /**
   * Force logout user (admin)
   * Invalidates all active sessions for the specified user, immediately ending any current logins.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 All sessions invalidated successfully
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on users resource
   * @response 404 User not found
   */
  @Del('sessions/:user')
  @Permission(['updateAny', 'updateOwn'])
  public async logoutUser(@FromModel({ queryField: 'Uuid', model: () => userModel() }) user: User) {
    await this.SessionProvider.deleteByUser(user.Id);

    this.Log.info(`All sessions revoked by administrator`, { User: user.Uuid });

    return new Ok(null, { Headers: [{ Name: 'Cache-Control', Value: 'no-store' }] });
  }

  protected toEntry(session: ISession): IAdminSessionEntry {
    return {
      Handle: hashSessionId(session.SessionId),
      Created: session.Creation?.toISO() ?? '',
      Expires: session.Expiration?.toISO() ?? null,
    };
  }
}
