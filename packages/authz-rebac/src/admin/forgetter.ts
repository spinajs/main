import { ScopeForgetter } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { tupleKey } from '../keys.js';
import { tupleChanged, tupleTags, writableStore, writeTuples } from './common.js';

/**
 * scope.forget for ReBAC: the tuples whose object is the node, and those whose subject is the node or a set of it,
 * wherever they are held, so a later node with the same id inherits nothing. A domain without a writable TupleStore has none.
 */
@Singleton()
@Injectable(ScopeForgetter)
export class RebacScopeForgetter extends ScopeForgetter {
  async forget(scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    const none = { affected: 0, tags: [], events: [] };
    if (scope.id == null) return none;
    const store = await writableStore(ctx, false);
    if (!store) return none;
    const { items: on } = await store.find({ object: { type: scope.type, id: scope.id } });
    const found = new Map([...on, ...(await store.withSubjectObject(scope))].map((t) => [tupleKey(t), t]));
    if (found.size === 0) return none;
    const { removed } = await writeTuples(store, tx, [], [...found.values()], ctx);
    if (removed.length === 0) return none;
    return { affected: removed.length, tags: tupleTags(ctx, new Set(removed.map((t) => t.object.type))), events: removed.map((t) => tupleChanged(ctx, t, 'delete')) };
  }
}
