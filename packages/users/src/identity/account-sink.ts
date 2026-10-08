import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { ev } from '@spinajs/queue';
import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent, IdentityRef } from '@spinajs/authn/contracts';

import { UserActivated } from '../events/UserActivated.js';
import { UserChanged } from '../events/UserPropertyChanged.js';
import { USER_COMMON_METADATA, User } from '../models/User.js';
import { runAsSystem } from '../system.js';
import { USERS_TABLE, invitePending, raw, recordPasswordSetAt, rowsAffected, usersDriver } from './sql.js';

/**
 * Keeps the users row in step with authn-local's password flows:
 *
 * - `PasswordSetAt` = `event.at` when a password is really set: `password.change` (a change, or an admin `set`)
 *   without `data.expired`, `password.reset`, `invite.redeem`. The store cannot tell these from a login rehash or
 *   the `'!expired'` marker, which also go through `PasswordCredentialStore.set`.
 * - On `invite.redeem`, an identity still marked `user:invite:pending` becomes active, loses the marker and
 *   `UserActivated` is emitted (no mail: the owner is on the page that did it).
 *
 * Its statements run as SYSTEM: the event's caller may be anonymous (a reset or an invite link). Failures are logged
 * by class and never thrown: the publishers only log a sink's error, and the password was stored already.
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
    await runAsSystem('account-sink', () => recordPasswordSetAt(id.id, at));
  }

  /**
   * One conditional statement activates the row only while its marker is a stored boolean true, so a `deactivate`
   * (which drops the marker first) cannot be undone by a redeem read a moment earlier. Idempotent.
   */
  protected async activateInvited(id: IdentityRef): Promise<void> {
    const u = await runAsSystem('account-sink', async () => {
      const driver = usersDriver();
      const updated = await driver
        .update()
        .in(USERS_TABLE)
        .update({ IsActive: true })
        .where('Uuid', id.id)
        .where(raw(invitePending(driver)));
      if (rowsAffected(updated) !== 1) {
        return undefined;
      }

      const activated = await User.query().where('Uuid', id.id).populate('Metadata').first();
      await activated?.Metadata.delete(USER_COMMON_METADATA.USER_INVITE_PENDING);
      return activated;
    });
    if (!u) {
      return;
    }

    await ev(new UserChanged(u));
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
