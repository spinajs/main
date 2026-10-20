import { ScopeForgetter, memoryTx } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { DbPolicyStore, policyTags } from '../model/stores/db.js';
import { policiesInTx, policyChanged, writableStore } from './common.js';

/**
 * scope.forget for ABAC: the writable store's policies whose scope is exactly the node. Policies at a type
 * (`{ type: 'project' }`) or at an ancestor stay. A domain without a writable PolicyStore has none to forget.
 */
@Singleton()
@Injectable(ScopeForgetter)
export class AbacScopeForgetter extends ScopeForgetter {
  async forget(scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    const store = await writableStore(ctx, false);
    if (!store) return { affected: 0, tags: [], events: [] };
    const undo = store instanceof DbPolicyStore ? undefined : memoryTx(tx);
    const tags = new Set<string>();
    const events: AuthzEvent[] = [];
    let affected = 0;
    for (const p of await policiesInTx(store, tx, { scope })) {
      if (store instanceof DbPolicyStore) {
        if ((await store.delete(p.id, tx)).affected === 0) continue;
      } else {
        store.delete(p.id);
        undo!.onRollback(() => store.put(p));
      }
      affected++;
      for (const t of policyTags(p.id)) tags.add(t);
      events.push(policyChanged(ctx, p, 'delete'));
    }
    return { affected, tags: [...tags], events };
  }
}
