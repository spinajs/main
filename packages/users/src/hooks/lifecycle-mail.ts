import { ActionHook } from '@spinajs/hooks';
import type { ActionName, ActionPattern, AfterContext } from '@spinajs/hooks';

import '../hooks.js';

/** Sends the lifecycle mail of each users action after it succeeded. */
export class UserLifecycleMailHook extends ActionHook {
  readonly actions: readonly ActionPattern[] = ['users.create', 'users.activate', 'users.deactivate', 'users.ban', 'users.unban', 'users.delete', 'users.password.expire'];

  public after(_ctx: AfterContext<ActionName>): Promise<void> {
    throw new Error('not implemented: UserLifecycleMailHook.after');
  }
}
