import { AuthzAdminFailure, AuthzConfigError, ListSupportGuard } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, RuleDef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { ruleCanMatch } from '../model/list/support.js';
import { permissionRegistry, quote } from './common.js';

/** Design §7 at write time: a stored rule may never reach a `list: true` permission. */
@Singleton()
@Injectable(ListSupportGuard)
export class RbacRuleListGuard extends ListSupportGuard {
  async checkCommand(c: AuthzCommand, ctx: AdminContext): Promise<void> {
    if (c.kind !== 'rule.put') return;
    const rule = c.rule as Pick<RuleDef, 'id' | 'kind' | 'resourceTypes' | 'permissions'>;
    const registry = await permissionRegistry(ctx);
    if (!registry) throw new AuthzConfigError(`Authz domain ${quote(ctx.domain)}: RbacRuleListGuard needs the permission registry to find the list permissions`);
    for (const def of [...registry.all()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!def.list) continue;
      const type = def.types.find((t) => ruleCanMatch(rule, def.name, t));
      if (type !== undefined) throw new AuthzAdminFailure('not_list_filterable', `rbac rule '${rule.id}' (${rule.kind}) can apply to ${def.name} on ${JSON.stringify(type)}, which is list: true; lists cannot follow rules`, 'rule');
    }
  }
}
