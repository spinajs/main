import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Post } from '@spinajs/http';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { activate, ban, deactivate, unban, userModel } from '@spinajs/users';
import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { Schema } from '@spinajs/validation';

import { AccountGuard } from '../../../services/AccountGuard.js';
import { userActor } from '../../../services/actor.js';
import { requireEveryUser, userRowFor } from '../../../services/users-access.js';

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

/** The user `uuid` with its metadata (the ban lives there), for a caller holding `permission` on every user. */
async function lifecycleTarget(caller: Principal, permission: 'users:update' | 'users:delete', uuid: string) {
  await requireEveryUser(caller, permission);
  return userRowFor(caller, permission, () => userModel().query().where('Uuid', uuid).populate('Metadata').first());
}

// users' 2.x session store no longer holds the 3.0 sessions: a listing would be empty and a forced logout would end
// nothing. Until these routes move onto the SessionIssuer they refuse rather than pretend.
function sessionRoutesPending(): MethodNotImplemented {
  return new MethodNotImplemented('the admin session routes are not served until they move onto the 3.0 session issuer');
}

/**
 * User account lifecycle (admin).
 * Activation, deactivation and bans. Each route sits on `@Access('users:<action>')` and needs a
 * grant on every user: a conditional grant (e.g. `self`) changes no account's standing.
 * Credential management (password, reset, expiry, two-factor) is served by authn-http under
 * `/authn/admin/users/:uuid/*`.
 *
 * Every route that takes an account out of service goes through the
 * {@link AccountGuard} first — an administrator must not be able to lock themselves,
 * or the installation, out through this API.
 * @tags Admin Users
 */
@BasePath('users/security')
export class Security extends BaseController {
  @Autoinject(AccountGuard)
  protected AccountGuard: AccountGuard;

  /**
   * Deactivate user account (admin)
   * Marks the user account as inactive and destroys its sessions, preventing login without
   * deleting the record.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 Account deactivated successfully
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:delete` on every user, the caller is not a signed-in user, or refused by the account guard (own account, last privileged account)
   * @response 404 User not found
   */
  @Post('deactivate/:user')
  @Access('users:delete')
  public async deactivateUser(@CurrentPrincipal() caller: Principal, @Param() user: string) {
    const by = userActor(caller);
    const target = await lifecycleTarget(by, 'users:delete', user);

    await this.AccountGuard.assertCanDisable(by, target, 'deactivate');
    await deactivate(target);

    return new Ok();
  }

  /**
   * Activate user account (admin)
   * Marks a previously deactivated user account as active, restoring login access.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 Account activated successfully
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:update` on every user
   * @response 404 User not found
   */
  @Post('activate/:user')
  @Access('users:update')
  public async activateUser(@CurrentPrincipal() caller: Principal, @Param() user: string) {
    await activate(await lifecycleTarget(caller, 'users:update', user));
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
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:delete` on every user, the caller is not a signed-in user, or refused by the account guard (own account, last privileged account)
   * @response 404 User not found
   */
  @Post('ban/:user')
  @Access('users:delete')
  public async banUser(@CurrentPrincipal() caller: Principal, @Param() user: string, @Body() dto: BanUserDto) {
    const by = userActor(caller);
    const target = await lifecycleTarget(by, 'users:delete', user);

    await this.AccountGuard.assertCanDisable(by, target, 'ban');
    await ban(target, dto?.reason, dto?.duration);

    return new Ok();
  }

  /**
   * Unban a user (admin)
   * Clears the ban metadata from the account.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 Account unbanned
   * @response 400 Account is not banned
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:update` on every user
   * @response 404 User not found
   */
  @Post('unban/:user')
  @Access('users:update')
  public async unbanUser(@CurrentPrincipal() caller: Principal, @Param() user: string) {
    await unban(await lifecycleTarget(caller, 'users:update', user));
    return new Ok();
  }

  /**
   * List sessions of a user (admin)
   * Not served yet: answers 500 until the route reads the 3.0 sessions.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @returns {IAdminSessionEntry[]} Live sessions of the user
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:read`
   */
  @Get('sessions/:user')
  @Access('users:read')
  public async listSessions(): Promise<Ok<IAdminSessionEntry[]>> {
    throw sessionRoutesPending();
  }

  /**
   * Revoke one session of a user (admin)
   * Not served yet: answers 500 until the route ends 3.0 sessions.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @param handle Session handle as returned by `GET /users/security/sessions/:user`
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:update`
   */
  @Del('sessions/:user/:handle')
  @Access('users:update')
  public async revokeSession(): Promise<Ok> {
    throw sessionRoutesPending();
  }

  /**
   * Force logout user (admin)
   * Not served yet: answers 500 until the route ends 3.0 sessions.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:update`
   */
  @Del('sessions/:user')
  @Access('users:update')
  public async logoutUser(): Promise<Ok> {
    throw sessionRoutesPending();
  }
}
