import { ScopeForgetter } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { tupleChanged, tupleTags, writableStore, writeTuples } from './common.js';

/** scope.forget for ReBAC: the tuples whose object is the node. A domain without a writable TupleStore has none. */
@Singleton()
@Injectable(ScopeForgetter)
export class RebacScopeForgetter extends ScopeForgetter {
  async forget(scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    const none = { affected: 0, tags: [], events: [] };
    if (scope.id == null) return none;
    const store = await writableStore(ctx, false);
    if (!store) return none;
    const { items } = await store.find({ object: { type: scope.type, id: scope.id } });
    if (items.length === 0) return none;
    const { removed } = await writeTuples(store, tx, [], items, ctx);
    if (removed.length === 0) return none;
    return { affected: removed.length, tags: tupleTags(ctx, [scope.type]), events: removed.map((t) => tupleChanged(ctx, t, 'delete')) };
  }
}
