import { Injectable, Singleton } from '@spinajs/di';

import { AuthzAdminFailure } from '../../contracts/admin.js';
import type { AdminContext, AuthzAdminQuery } from '../../contracts/admin.js';
import type { ResourceRef } from '../../contracts/principal.js';
import { ScopeAttributeStore } from '../../contracts/adapter.js';
import { AuthzConfigError } from '../../contracts/errors.js';
import { adminContainer } from '../context.js';
import { AuthzAdminReader } from '../ports.js';

/** Answers list queries of kind 'attributes': the stored attributes of the scope, without schema defaults or resolver values. */
@Singleton()
@Injectable(AuthzAdminReader)
export class ScopeAttributeReader extends AuthzAdminReader {
  readonly kinds = ['attributes'] as const;

  async list(q: AuthzAdminQuery, ctx: AdminContext): Promise<{ items: readonly unknown[]; total: number }> {
    if (q.kind !== 'attributes') throw new AuthzConfigError(`ScopeAttributeReader cannot answer query kind ${JSON.stringify(q.kind)}`);
    const scope: unknown = q.scope;
    if (scope === null || typeof scope !== 'object' || typeof (scope as ResourceRef).type !== 'string' || (scope as ResourceRef).type === '') throw new AuthzAdminFailure('invalid_query', 'an attributes query needs a scope', 'scope');
    const container = adminContainer(ctx);
    if (!container.hasRegistered(ScopeAttributeStore)) return { items: [{}], total: 1 };
    const store = (await container.resolve(ScopeAttributeStore)) as ScopeAttributeStore;
    return { items: [await store.get(q.scope)], total: 1 };
  }
}
