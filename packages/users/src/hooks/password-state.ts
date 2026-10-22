import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { ev } from '@spinajs/queue';
import { ActionHook } from '@spinajs/hooks';
import type { ActionName, ActionPattern, AfterContext } from '@spinajs/hooks';
import type { AuthnContext, IdentityRef } from '@spinajs/authn/contracts';
import type { PasswordResetOutput } from '@spinajs/authn-local';

import { UserActivated } from '../events/UserActivated.js';
import { UserChanged } from '../events/UserPropertyChanged.js';
import { USER_COMMON_METADATA, User } from '../models/User.js';
import { runAsSystem } from '../system.js';
import { USERS_TABLE, invitePending, raw, recordAddressVerifiedAt, recordPasswordSetAt, rowsAffected, usersDriver } from '../identity/sql.js';

/** The status each action answers when it really set a password. */
const SET: ReadonlyMap<string, string> = new Map([
  ['authn.password.change', 'changed'],
  ['authn.password.set', 'set'],
  ['authn.password.reset.redeem', 'reset'],
]);

/**
 * Keeps the users row in step with authn-local's password flows, as an after hook:
 *
 * - `PasswordSetAt` = the action's `ctx.now` when a password was really set: `authn.password.change` (`changed`),
 *   `authn.password.set` (`set`), `authn.password.reset.redeem` (`reset`). An expiry is another action, so its
 *   `'!expired'` marker never counts.
 * - On a redeem, an identity still marked `user:invite:pending` becomes active, loses the marker and `UserChanged` and
 *   `UserActivated` are emitted (no mail: the owner is on the page that did it), also when a reset link completed the
 *   invite. An invite redeem, or one that activated the account, sets `EmailVerifiedAt` unless set: the secret was
 *   mailed to that address.
 *
 * Its statements run as SYSTEM: the redeemer may be anonymous. Failures are logged by class and never thrown: the
 * password was stored already.
 */
@Injectable(ActionHook)
export class UserPasswordStateHook extends ActionHook {
  readonly actions: readonly ActionPattern[] = [...SET.keys()] as ActionPattern[];

  @Logger('users')
  protected Log: Log;

  public async after(ctx: AfterContext<ActionName>): Promise<void> {
    const output = ctx.output as { readonly status?: string } | undefined;
    if (output?.status === undefined || output.status !== SET.get(ctx.action)) return;

    const input = ctx.input as { readonly id?: IdentityRef; readonly ctx: AuthnContext };
    const redeem = ctx.action === 'authn.password.reset.redeem' ? (output as Extract<PasswordResetOutput, { status: 'reset' }>) : undefined;
    const id = redeem ? redeem.id : input.id;
    if (id?.type !== 'user' || typeof id.id !== 'string') return;
    const at = new Date(input.ctx.now);

    await this.guarded(ctx.action, id, 'Could not record when its password was set on ${action} of user ${userId}: ${errorClass}', () => this.recordPasswordSet(id, at));
    if (!redeem) return;

    const activated = (await this.guarded(ctx.action, id, 'Could not activate its invited account on ${action} of user ${userId}: ${errorClass}', () => this.activateInvited(id))) === true;
    if (redeem.purpose === 'invite' || activated) {
      await this.guarded(ctx.action, id, 'Could not record its verified address on ${action} of user ${userId}: ${errorClass}', () => runAsSystem('password-state', () => recordAddressVerifiedAt(id.id, at)));
    }
  }

  protected async recordPasswordSet(id: IdentityRef, at: Date): Promise<void> {
    await runAsSystem('password-state', () => recordPasswordSetAt(id.id, at));
  }

  /**
   * One conditional statement activates the row only while its marker is a stored boolean true, so a `deactivate`
   * (which drops the marker first) cannot be undone by a redeem read a moment earlier. Idempotent; true when it activated.
   */
  protected async activateInvited(id: IdentityRef): Promise<boolean> {
    const u = await runAsSystem('password-state', async () => {
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
      return false;
    }

    await ev(new UserChanged(u));
    await ev(new UserActivated(u));
    return true;
  }

  private async guarded<T>(action: string, id: IdentityRef, failure: string, work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (err) {
      // The class only: a driver error's message carries the statement and its bindings.
      this.Log.warn({ action, userId: id.id, errorClass: (err as Error)?.name ?? typeof err }, failure);
      return undefined;
    }
  }
}
