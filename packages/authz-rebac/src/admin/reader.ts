import { AuthzAdminReader } from '@spinajs/authz';
import type { AdminContext, AuthzAdminQuery } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

/** list() of the tuples in the domain's writable TupleStore, narrowed by scope (object or namespace), relation and subject. */
@Singleton()
@Injectable(AuthzAdminReader)
export class RebacTupleReader extends AuthzAdminReader {
  readonly kinds = ['tuples'] as const;

  async list(_q: AuthzAdminQuery, _ctx: AdminContext): Promise<{ items: readonly unknown[]; total: number }> {
    throw new Error('not implemented: RebacTupleReader.list');
  }
}
