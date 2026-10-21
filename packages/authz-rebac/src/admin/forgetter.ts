import { ScopeForgetter } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

/** scope.forget for ReBAC: the tuples whose object is the node. A domain without a writable TupleStore has none. */
@Singleton()
@Injectable(ScopeForgetter)
export class RebacScopeForgetter extends ScopeForgetter {
  async forget(_scope: ResourceRef, _ctx: AdminContext, _tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    throw new Error('not implemented: RebacScopeForgetter.forget');
  }
}
