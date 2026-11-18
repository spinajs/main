import { AsyncLocalStorage } from 'node:async_hooks';
import { DI, Injectable } from '@spinajs/di';
import { IdempotencyScopePart } from '@spinajs/http';
import { tenantScope } from '@spinajs/tenancy';

// No tenant id matches it: the id pattern has no '*'.
const ALL_TENANTS = 'tenant:*';

/**
 * Keeps the idempotency keys of tenants apart: users are global, so one principal sending one key in two tenants would
 * otherwise get the reply stored in the other, or its refusal as in flight or reused. One part covers the all-tenants
 * scope whatever its reason; a request or connection with no scope adds none, so its key is the key without tenancy.
 */
@Injectable(IdempotencyScopePart)
export class TenantIdempotencyScope extends IdempotencyScopePart {
  public partOf(store: object): string | undefined {
    // tenantScope() is the reader that checks the stored scope, and it reads the ambient store
    const scope = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<object>).run(store, tenantScope);
    if (scope === undefined) return undefined;
    return scope.kind === 'tenant' ? `tenant:${scope.tenant.id}` : ALL_TENANTS;
  }
}
