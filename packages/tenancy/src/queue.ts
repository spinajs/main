import { Injectable } from '@spinajs/di';
import { PermanentJobFailure, QueueHeaders, QueueMessageHook, jobOptions } from '@spinajs/queue';
import type { IQueueMessage } from '@spinajs/queue';
import type { TenantScope } from './contracts.js';
import { allTenantsScope, establishTenantScope, isTenantId, tenantScope, tenantScopeOf } from './scope.js';

const ALL = '*:';

/** Below authz-queue's hook (order 0): the tenant is in place when that hook checks a job's `access`. */
export const TENANT_QUEUE_HOOK_ORDER = -100;

/** The tenant id, or `*:` and the URI-encoded reason for the cross-tenant scope; a tenant id never holds `*`. */
export function encodeTenantHeader(scope: TenantScope): string {
  return scope.kind === 'tenant' ? scope.tenant.id : `${ALL}${encodeURIComponent(scope.reason)}`;
}

export function decodeTenantHeader(value: string | undefined): TenantScope | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith(ALL)) return isTenantId(value) ? tenantScopeOf(value) : undefined;
  try {
    return allTenantsScope(decodeURIComponent(value.slice(ALL.length)));
  } catch {
    return undefined;
  }
}

/** Writes the emitter's tenant scope into `x-spinajs-tenant` and runs the handler in the scope the message names. */
@Injectable(QueueMessageHook)
export class TenantQueueHook extends QueueMessageHook {
  public override readonly order: number = TENANT_QUEUE_HOOK_ORDER;

  public beforeEmit(message: IQueueMessage): void {
    // Whatever the caller put there is dropped: only the ambient scope may be named.
    const { [QueueHeaders.Tenant]: _claimed, ...headers } = message.Headers ?? {};
    const scope = tenantScope();
    if (scope) headers[QueueHeaders.Tenant] = encodeTenantHeader(scope);

    if (Object.keys(headers).length > 0) message.Headers = headers;
    else delete message.Headers;
  }

  // The scope is always replaced, never inherited: a consumer can run inside its emitter's async context.
  public async aroundHandle<T>(message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    const tenancy = jobOptions(message).tenancy ?? 'carry';
    if (tenancy === 'none') return establishTenantScope(undefined, next);

    const scope = decodeTenantHeader(message.Headers?.[QueueHeaders.Tenant]);
    if (tenancy === 'required' && scope?.kind !== 'tenant') {
      throw new PermanentJobFailure('tenant_required', `${message.Name} needs a tenant and the message carries ${scope ? 'the cross-tenant scope' : 'none'}`);
    }
    return establishTenantScope(scope, next);
  }
}
