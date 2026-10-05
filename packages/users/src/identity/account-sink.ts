import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { ev } from '@spinajs/queue';
import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent, IdentityRef } from '@spinajs/authn/contracts';

import { updateUser } from '../actions.js';
import { UserActivated } from '../events/UserActivated.js';
import { USER_COMMON_METADATA, User } from '../models/User.js';
import { USERS_TABLE, sqlDateTime, usersDriver } from './sql.js';

/**
 * Keeps the users row in step with authn-local's password flows:
 *
 * - `PasswordSetAt` = `event.at` when a password is really set: `password.change` (a change, or an admin `set`)
 *   without `data.expired`, `password.reset`, `invite.redeem`. The store cannot tell these from a login rehash or
 *   the `'!expired'` marker, which also go through `PasswordCredentialStore.set`.
 * - On `invite.redeem`, an identity still marked `user:invite:pending` becomes active, loses the marker and
 *   `UserActivated` is emitted (no mail: the owner is on the page that did it).
 *
 * Failures are logged by class and never thrown: the publishers only log a sink's error, and the password was
 * stored already.
 */
@Injectable(AuthnEventSink)
export class UserAccountSink extends AuthnEventSink {
  @Logger('rbac')
  protected Log: Log;

  public async publish(e: AuthnEvent): Promise<void> {
    if (e.outcome !== 'success' || e.identity?.type !== 'user') {
      return;
    }

    const setsPassword = (e.type === 'password.change' && e.data?.expired !== true) || e.type === 'password.reset' || e.type === 'invite.redeem';
    if (setsPassword) {
      await this.guarded(e, 'record when its password was set', () => this.recordPasswordSet(e.identity!, e.at));
    }

    if (e.type === 'invite.redeem') {
      await this.guarded(e, 'activate its invited account', () => this.activateInvited(e.identity!));
    }
  }

  protected async recordPasswordSet(id: IdentityRef, at: Date): Promise<void> {
    await usersDriver().update().in(USERS_TABLE).update({ PasswordSetAt: sqlDateTime(at) }).where('Uuid', id.id);
  }

  /** Idempotent: an identity without the marker is left alone. */
  protected async activateInvited(id: IdentityRef): Promise<void> {
    const u = await User.query().where('Uuid', id.id).populate('Metadata').first();
    if (!u || u.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING] !== true) {
      return;
    }

    await updateUser(u, { IsActive: true });
    await u.Metadata.delete(USER_COMMON_METADATA.USER_INVITE_PENDING);
    await ev(new UserActivated(u));
  }

  private async guarded(e: AuthnEvent, what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      // The class only: a driver error's message carries the statement and its bindings.
      this.Log.warn(`Could not ${what} on ${e.type} of user ${e.identity!.id}: ${(err as Error)?.name ?? typeof err}`);
    }
  }
}
