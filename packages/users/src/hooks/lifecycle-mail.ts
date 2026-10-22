import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { ActionHook } from '@spinajs/hooks';
import type { ActionName, ActionPattern, AfterContext } from '@spinajs/hooks';

import { sendUserEmail } from '../actions.js';
import { userModel } from '../model-token.js';
import { runAsSystem } from '../system.js';
import type { User } from '../models/User.js';
import type { UserView, UsersCreateOutput } from '../hooks.js';

type LifecycleMail = Parameters<typeof sendUserEmail>[1];

/** The `users.email.*` entry each action mails, as the actions sent it inline before 3.x. */
const MAILS: ReadonlyMap<string, LifecycleMail> = new Map<string, LifecycleMail>([
  ['users.create', 'created'],
  ['users.activate', 'activated'],
  ['users.deactivate', 'deactivated'],
  ['users.ban', 'banned'],
  ['users.unban', 'unbanned'],
  ['users.delete', 'deleted'],
  ['users.password.expire', 'passwordExpired'],
]);

/**
 * Sends the lifecycle mail of a users action once it succeeded: `created` (a create with a password; an invited account
 * gets authn-local's invite instead), `activated`, `deactivated`, `banned`, `unbanned`, `deleted`, `passwordExpired`.
 * A mail that fails (a template missing from `users.email`, a queue down) is logged and never fails the action.
 *
 * Registered by users. To replace one mail, extend it and override {@link UserLifecycleMailHook.send}; to send none,
 * `DI.unregister(UserLifecycleMailHook)` before the application boots.
 */
@Injectable(ActionHook)
export class UserLifecycleMailHook extends ActionHook {
  readonly actions: readonly ActionPattern[] = [...MAILS.keys()] as ActionPattern[];

  @Logger('users')
  protected Log: Log;

  public async after(ctx: AfterContext<ActionName>): Promise<void> {
    const mail = MAILS.get(ctx.action);
    if (!mail) return;

    let uuid: string;
    if (ctx.action === 'users.create') {
      const created = ctx.output as UsersCreateOutput;
      if (created.Invited) return;
      uuid = created.User.Uuid;
    } else {
      uuid = (ctx.input as { user: UserView }).user.Uuid;
    }

    try {
      const u = await this.recipient(uuid);
      if (!u) {
        this.Log.warn({ action: ctx.action, mail, userUuid: uuid }, 'The ${mail} mail of ${action} was not sent: user ${userUuid} not found');
        return;
      }
      await this.send(u, mail);
    } catch (err) {
      // The class only: a driver or transport error can carry the address and the model.
      this.Log.warn({ action: ctx.action, mail, errorClass: err instanceof Error ? err.constructor.name : typeof err }, 'The ${mail} mail of ${action} was not sent: ${errorClass}');
    }
  }

  /**
   * The user as the action left it, the model the mail template gets; a deleted one included. As SYSTEM: the caller
   * may not read the row through an `@AccessResource` user model, and the mail must not depend on that.
   */
  protected async recipient(uuid: string): Promise<User | undefined> {
    return runAsSystem('lifecycle-mail', async () => (await userModel().query().withDeleted().where('Uuid', uuid).populate('Metadata').first()) ?? undefined);
  }

  protected async send(u: User, mail: LifecycleMail): Promise<void> {
    await sendUserEmail(u, mail);
  }
}
