import { AuthzWriteHandler } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzEvent, AuthzTx, Permission, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

export const TUPLES_MANAGE: Permission = 'authz:tuples.manage';

/**
 * tuple.write and tuple.delete on the domain's writable TupleStore (a MemoryTupleStore or DbTupleStore
 * registered as TupleStore), each tuple checked against every RebacModel of the domain.
 */
@Singleton()
@Injectable(AuthzWriteHandler)
export class RebacTupleHandler extends AuthzWriteHandler {
  readonly kinds = ['tuple.write', 'tuple.delete'] as const;

  async validate(_c: AuthzCommand, _ctx: AdminContext): Promise<void> {
    throw new Error('not implemented: RebacTupleHandler.validate');
  }

  permission(_c: AuthzCommand, _ctx: AdminContext): { permission: Permission; resource: ResourceRef } {
    throw new Error('not implemented: RebacTupleHandler.permission');
  }

  async apply(_c: AuthzCommand, _ctx: AdminContext, _tx: AuthzTx): Promise<{ id?: string; affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    throw new Error('not implemented: RebacTupleHandler.apply');
  }
}
