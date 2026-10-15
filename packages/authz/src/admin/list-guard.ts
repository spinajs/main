import { Injectable, Singleton } from '@spinajs/di';

import { AuthzAdminFailure, AuthzCommandValidator } from '../contracts/admin.js';
import type { AdminContext, AuthzCommand } from '../contracts/admin.js';
import { AuthzConfigError } from '../contracts/errors.js';
import type { Principal } from '../contracts/principal.js';
import { adminContainer } from './context.js';

/**
 * Design §7 at write time: the model that owns the data a policy.put or rule.put changes says whether
 * every `list: true` permission stays list-filterable with it (RBAC registers one for rules, ABAC for
 * policies). Refuses by throwing; the message names the permission, the rule or policy, and why.
 */
export abstract class ListSupportGuard {
  abstract checkCommand(c: AuthzCommand, ctx: AdminContext): Promise<void>;
}

const FIELD: Readonly<Record<string, string>> = Object.freeze({ 'policy.put': 'policy', 'rule.put': 'rule' });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const className = (v: unknown): string => (isObject(v) && typeof v.constructor === 'function' ? v.constructor.name : String(v));

@Singleton()
@Injectable(AuthzCommandValidator)
export class ListSupportValidator extends AuthzCommandValidator {
  async validate(_actor: Principal, c: AuthzCommand, ctx: AdminContext): Promise<void> {
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
}
