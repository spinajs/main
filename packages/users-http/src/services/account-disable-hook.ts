import { Autoinject, Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import '@spinajs/users';

import { AccountStanding } from './AccountGuard.js';
import type { AccountDisableAction } from './AccountGuard.js';

type Disabling = 'users.deactivate' | 'users.ban' | 'users.delete';

const VERBS: Readonly<Record<Disabling, AccountDisableAction>> = { 'users.deactivate': 'deactivate', 'users.ban': 'ban', 'users.delete': 'delete' };

/** An AccountDisableHook's `order`: before the hooks of the default order, so they only see what it let through. */
export const ACCOUNT_DISABLE_HOOK_ORDER = -1000;

/**
 * The account guard of the actions that take an account out of service: a before hook on `users.deactivate`,
 * `users.ban` and `users.delete` that refuses `self_lockout` and `last_holder` ({@link AccountStanding.disableRefusal},
 * `authz.admin.guard`) with the reason as the message. users-http's routes answer both 403 with that message. It judges
 * the actor the action was given, whoever runs it; an action run as SYSTEM (users' default actor, the CLI) is not
 * judged, as AuthzAdmin's guard does not judge SYSTEM.
 *
 * Registered by users-http. To change the rule, extend it and register the subclass in its place.
 */
@Injectable(ActionHook)
export class AccountDisableHook extends ActionHook<Disabling> {
  readonly actions: readonly ActionPattern[] = Object.keys(VERBS) as ActionPattern[];
  readonly order: number = ACCOUNT_DISABLE_HOOK_ORDER;

  @Autoinject(AccountStanding)
  protected Standing: AccountStanding;

  public async before(ctx: BeforeContext<Disabling>): Promise<void> {
    const { actor, user } = ctx.input;
    if (actor.type === 'system') {
      return;
    }

    const refusal = await this.Standing.disableRefusal(actor, user, VERBS[ctx.action]);
    if (refusal) {
      ctx.refuse(refusal.code, refusal.message);
    }
  }
}
