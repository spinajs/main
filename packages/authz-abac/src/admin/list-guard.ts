import { AuthzAdminFailure, ListSupportGuard } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, Policy } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { abacModels } from './common.js';

/** Design §7 at write time: policy.put may not make a `list: true` permission need the row. */
@Singleton()
@Injectable(ListSupportGuard)
export class AbacListSupportGuard extends ListSupportGuard {
  async checkCommand(c: AuthzCommand, ctx: AdminContext): Promise<void> {
    if (c.kind !== 'policy.put') return;
    for (const model of abacModels(ctx)) {
      const problem = model.listProblem(c.policy as Omit<Policy, 'source'>);
      if (problem !== undefined) throw new AuthzAdminFailure('not_list_filterable', problem, 'policy');
    }
  }
}
