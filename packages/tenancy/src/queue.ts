import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { PermanentJobFailure, QueueHeaders, QueueMessageHook, jobOptions } from '@spinajs/queue';
import type { IQueueMessage } from '@spinajs/queue';
import type { TenantScope } from './contracts.js';
import { TenantUnavailable } from './errors.js';
import { allTenantsScope, establishTenantScope, isTenantId, tenantScope, tenantScopeOf } from './scope.js';
import { admitTenant } from './services.js';

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

  @Logger('tenancy')
  protected Log: Log;

  public beforeEmit(message: IQueueMessage): void {
    // Whatever the caller put there is dropped, in any letter case: only the ambient scope may be named.
    const headers = Object.fromEntries(Object.entries(message.Headers ?? {}).filter(([name]) => name.toLowerCase() !== QueueHeaders.Tenant));
    const scope = tenantScope();
    if (scope) headers[QueueHeaders.Tenant] = encodeTenantHeader(scope);

    if (Object.keys(headers).length > 0) message.Headers = headers;
    else delete message.Headers;
  }

  // The scope is always replaced, never inherited: a consumer can run inside its emitter's async context.
  public async aroundHandle<T>(message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    const tenancy = jobOptions(message).tenancy ?? 'carry';
    if (tenancy === 'none') return establishTenantScope(undefined, next);

    // Typed as a string, but a body-only transport (SQS) hands over whatever the publisher put in the JSON.
    const raw: unknown = message.Headers?.[QueueHeaders.Tenant];
    const scope = typeof raw === 'string' ? decodeTenantHeader(raw) : undefined;
    if (tenancy === 'carry' && raw !== undefined && scope === undefined) {
      // Only version skew or tampering writes such a value; a cross-tenant reason can be long.
      const detail = typeof raw === 'string' ? { header: raw.slice(0, 64), length: raw.length } : { type: typeof raw };
      this.Log.warn({ messageName: message.Name, ...detail }, 'Message ${messageName} carries a malformed tenant header; its handler runs with no tenant scope');
    }
    if (tenancy === 'required' && scope?.kind !== 'tenant') {
      throw new PermanentJobFailure('tenant_required', `${message.Name} needs a tenant and the message carries ${scope ? 'the cross-tenant scope' : 'none'}`);
    }
    if (scope?.kind === 'tenant') await this.admit(message, scope.tenant.id);
    return establishTenantScope(scope, next);
  }

  // The header says which tenant, the registry whether it may run now: the tenant can be suspended or gone since the emit.
  private async admit(message: IQueueMessage, tenant: string): Promise<void> {
    try {
      await admitTenant(tenant);
    } catch (error) {
      if (!(error instanceof TenantUnavailable)) {
        // Retried like any failure: the registry may answer next time, and a retry asks it again.
        this.Log.error({ error, messageName: message.Name, tenant }, 'Message ${messageName} refused: the tenant registry failed to look up tenant ${tenant}');
        throw error;
      }
      this.Log.warn({ messageName: message.Name, tenant, reason: error.reason }, 'Message ${messageName} refused: tenant ${tenant} is not admitted (${reason})');
      throw Object.assign(new PermanentJobFailure('tenant_unavailable', `${message.Name} cannot run in tenant "${tenant}": ${error.message}`), { cause: error });
    }
  }
}
