import { Autoinject, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { BaseController, BasePath, Body, Del, Get, NotFound, Ok, Param, Post, Req } from '@spinajs/http';
import type { IResponseHeader, Request } from '@spinajs/http';
import { ResourceNotFound } from '@spinajs/exceptions';
import { activate, ban, deactivate, unban, userModel } from '@spinajs/users';
import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { AuthnAudit } from '@spinajs/authn';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '@spinajs/authn-http';
import { Schema } from '@spinajs/validation';

import { AccountGuard } from '../../../services/AccountGuard.js';
import { userActor } from '../../../services/actor.js';
import { assertCredentialAdmin } from '../../../services/credential-admin.js';
import { freshAuthRefusal } from '../../../services/fresh-auth.js';
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
  /** The issuer's one-way handle of the session, never its id or storage key: the id is a working credential. */
  Handle: string;

  /** ISO instant the session was opened */
  Created: string;

  /** ISO instant the session was last used */
  LastSeen: string;

  /** Client ip stored for the session (the impersonator's, for an impersonation session) */
  Ip?: string;

  /** Client user agent stored for the session */
  UserAgent?: string;
}

const NO_STORE: IResponseHeader = Object.freeze({ Name: 'Cache-Control', Value: 'no-store' });

/** The policies of authn-http's credential admin routes: a session caller (no token, key or signature) not impersonating. */
const SESSION_ADMIN = [Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy];

async function sessionIssuer(): Promise<SessionIssuer> {
  if (!DI.RootContainer.hasRegistered(SessionIssuer as unknown as Class<SessionIssuer>)) {
    throw Object.assign(new ResourceNotFound('the admin session routes are off: no SessionIssuer is registered'), { error: 'not_found' });
  }
  return (await DI.resolve(SessionIssuer)) as SessionIssuer;
}

/**
 * The user `uuid` whose sessions the caller manages: `permission` decided on that row, then authn's
 * CredentialAdminGuard (action `sessions`), as on authn-http's `DELETE /authn/admin/users/:uuid/sessions`. The
 * subject is the stored Uuid, so it names exactly the identity the session store keys by.
 */
async function sessionsTarget(by: Principal, permission: 'users:read' | 'users:update', uuid: string): Promise<IdentityRef> {
  const row = await userRowFor(by, permission, () => userModel().query().where('Uuid', uuid).first());
  await assertCredentialAdmin(by, row.Uuid, 'sessions');
  return { type: 'user', id: row.Uuid };
}

/** The user `uuid` with its metadata (the ban lives there), for a caller holding `permission` on every user. */
async function lifecycleTarget(caller: Principal, permission: 'users:update' | 'users:delete', uuid: string) {
  await requireEveryUser(caller, permission);
  return userRowFor(caller, permission, () => userModel().query().where('Uuid', uuid).populate('Metadata').first());
}

/**
 * User account lifecycle and sessions (admin).
 * Activation, deactivation and bans. Each route sits on `@Access('users:<action>')` and needs a
 * grant on every user: a conditional grant (e.g. `self`) changes no account's standing.
 * Listing a user's sessions and ending one of them also need what authn-http's credential admin
 * routes need: a session caller that is not impersonating and authn's CredentialAdminGuard
 * (users': `users:credentials`, the target covered, no protected role).
 * authn-http serves `/authn/admin/users/:uuid/{password-reset,mfa-reset,sessions,tokens}`, the
 * forced logout of every session included; 3.0 has no admin route to set a password, expire one
 * or enable two-factor.
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
   * The user's live sessions from the session issuer, newest first, impersonation sessions of
   * the user included. Each entry names the session by its one-way handle, never by id.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @returns {IAdminSessionEntry[]} Live sessions of the user
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:read` on this user, a token or impersonating caller (`session_required`, `impersonating`), or refused by the credential admin guard (`forbidden`, `protected_role`, `escalation`; the caller's own sessions are `forbidden`: see `GET /user/sessions`)
   * @response 404 User not found
   */
  @Get('sessions/:user')
  @Access('users:read', { also: SESSION_ADMIN })
  public async listSessions(@CurrentPrincipal() caller: Principal, @Param() user: string): Promise<Ok<IAdminSessionEntry[]>> {
    const issuer = await sessionIssuer();
    const subject = await sessionsTarget(userActor(caller), 'users:read', user);

    const rows = await issuer.list(subject);
    const entries: IAdminSessionEntry[] = [...rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({
        Handle: r.handle,
        Created: r.createdAt.toISOString(),
        LastSeen: r.lastSeenAt.toISOString(),
        ...(r.ip !== undefined ? { Ip: r.ip } : {}),
        ...(r.userAgent !== undefined ? { UserAgent: r.userAgent } : {}),
      }));

    return new Ok(entries, { Headers: [NO_STORE] });
  }

  /**
   * Revoke one session of a user (admin)
   * Ends the user's session with that handle. Needs fresh authentication: a login within
   * authn.freshAuth.maxAgeSeconds, or the caller's password in the body field `reauthPassword`.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @param handle Session handle as returned by `GET /users/security/sessions/:user`
   * @response 200 Session ended
   * @response 401 Unauthorized — no signed-in principal, or a wrong `reauthPassword`
   * @response 403 Forbidden — no `users:update` on this user, no fresh authentication (`fresh_auth_required`), a token or impersonating caller, or refused by the credential admin guard (`forbidden`, `protected_role`, `escalation`; the caller's own sessions are `forbidden`: see `DELETE /user/sessions/:handle`)
   * @response 404 User not found, or no session of this user has that handle (`session_not_found`)
   */
  @Del('sessions/:user/:handle')
  @Access('users:update', { also: SESSION_ADMIN })
  public async revokeSession(@Req() req: Request, @CurrentPrincipal() caller: Principal, @Param() user: string, @Param() handle: string) {
    const by = userActor(caller);
    const issuer = await sessionIssuer();

    const stale = await freshAuthRefusal(req, this);
    if (stale) {
      return stale;
    }

    const subject = await sessionsTarget(by, 'users:update', user);

    // revokeHandle is owner-bound: a handle of another user's session through this uuid ends nothing.
    const ended = typeof handle === 'string' && handle !== '' && (await issuer.revokeHandle(subject, handle));
    if (!ended) {
      return new NotFound({ error: 'session_not_found', message: 'No such session' }, { Headers: [NO_STORE] });
    }

    // SessionIssuer audits nothing.
    const ip = req.storage.ClientIp;
    const userAgent = req.headers['user-agent'];
    await ((await DI.resolve(AuthnAudit)) as AuthnAudit).publish({
      type: 'session.revoke',
      outcome: 'success',
      reason: 'admin',
      at: new Date(),
      identity: subject,
      actor: { type: by.type, id: by.id },
      session: handle,
      ...(typeof ip === 'string' && ip !== '' ? { ip } : {}),
      ...(typeof userAgent === 'string' && userAgent !== '' ? { userAgent } : {}),
    });

    return new Ok(null, { Headers: [NO_STORE] });
  }
}
