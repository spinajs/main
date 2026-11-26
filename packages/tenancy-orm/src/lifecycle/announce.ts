import { TenantSwitchDenied, runInTenant, tenantRegistry, tenantScope } from '@spinajs/tenancy';

/** Forgets what this process cached of tenant `id`; other processes see the change when their cache entry expires. */
export async function announce(id: string): Promise<void> {
  (await tenantRegistry()).invalidate(id);
}

/** Enters tenant `id` for a lifecycle step; no entry point admitted it, since it is not active. */
export function inTenant<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return runInTenant(id, fn);
}

/** A lifecycle operation names its tenant and enters it itself. */
export function refuseTenantScope(operation: string): void {
  const scope = tenantScope();
  if (scope?.kind === 'tenant') {
    throw new TenantSwitchDenied(`tenancy-orm: ${operation} acts on the tenant it names and runs outside a tenant scope; it runs inside tenant "${scope.tenant.id}"`);
  }
}

export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
