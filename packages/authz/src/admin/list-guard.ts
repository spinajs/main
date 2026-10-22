import { Injectable, Singleton } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';

import { AuthzAdminFailure } from '../contracts/admin.js';
import type { AdminContext, AuthzCommand } from '../contracts/admin.js';
import { AuthzConfigError } from '../contracts/errors.js';
import { adminContainer } from './context.js';
import { boundCall, markListChecked, refuseWith } from './refusals.js';
import { isObject } from '../engine/internal/util.js';
import type {} from '../hooks.js';

/**
 * Design §7 at write time: the model that owns the data a policy.put or rule.put changes says whether
 * every `list: true` permission stays list-filterable with it (RBAC registers one for rules, ABAC for
 * policies). Refuses by throwing; the message names the permission, the rule or policy, and why.
 */
export abstract class ListSupportGuard {
  abstract checkCommand(c: AuthzCommand, ctx: AdminContext): Promise<void>;
}

const FIELD: Readonly<Record<string, string>> = Object.freeze({ 'policy.put': 'policy', 'rule.put': 'rule' });

const className = (v: unknown): string => (isObject(v) && typeof v.constructor === 'function' ? v.constructor.name : String(v));

/**
 * Runs every ListSupportGuard along the domain's container lineage on a policy.put or rule.put.
 * @throws AuthzAdminFailure not_list_filterable for a guard's refusal, or the AuthzAdminFailure a guard threw;
 *         AuthzConfigError for a guard that is no ListSupportGuard or that threw one
 */
export async function checkListSupport(c: AuthzCommand, ctx: AdminContext): Promise<void> {
  const field = FIELD[c.kind];
  if (field === undefined) return;
  const container = adminContainer(ctx);
  if (!container.hasRegistered(ListSupportGuard)) return;
  for (const guard of [...(await container.resolve(Array.chainOf(ListSupportGuard)))]) {
    if (!isObject(guard) || typeof guard.checkCommand !== 'function') throw new AuthzConfigError(`Authz domain ${JSON.stringify(ctx.domain)}: ${className(guard)} is not a ListSupportGuard`);
    try {
      await guard.checkCommand(c, ctx);
    } catch (e) {
      if (e instanceof AuthzAdminFailure || e instanceof AuthzConfigError) throw e;
      throw new AuthzAdminFailure('not_list_filterable', e instanceof Error ? e.message : String(e), field, { cause: e });
    }
  }
}

/**
 * The ListSupportGuard check as a before hook on `authz.admin.command`, after the handler's validate() and the
 * permission check. It runs last, so it judges the command the other hooks leave; AuthzAdmin checks itself a command
 * this hook did not judge (one a hook replaced). A refusal answers what the guard check answers (not_list_filterable,
 * a guard's own AuthzAdminFailure, or an AuthzConfigError that rejects the batch), never `hook:<code>`.
 */
@Singleton()
@Injectable(ActionHook)
export class ListSupportHook extends ActionHook<'authz.admin.command'> {
  readonly actions: readonly ActionPattern[] = ['authz.admin.command'];
  readonly order: number = Number.MAX_SAFE_INTEGER;

  async before(ctx: BeforeContext<'authz.admin.command'>): Promise<void> {
    const call = boundCall(ctx.input.command);
    if (!call) return;
    markListChecked(call.command);
    try {
      await checkListSupport(call.command, call.ctx);
    } catch (e) {
      if (e instanceof AuthzAdminFailure || e instanceof AuthzConfigError) refuseWith(ctx, 'not_list_filterable', e);
      throw e;
    }
  }
}
