import type { Principal } from '@spinajs/authz';
import { tenantRegistry } from '@spinajs/tenancy';
import type { TenantRecord } from '@spinajs/tenancy';

import { tenancyAuthz } from './host.js';
import { TENANT_ENTER, tenantResource } from './names.js';

const CHECK_BATCH = 100;

/** The active tenants `principal` may enter, in registry order: what a tenant switcher lists. */
export async function tenantsOf(principal: Principal): Promise<TenantRecord[]> {
  const authz = await tenancyAuthz();
  const out: TenantRecord[] = [];
  let batch: TenantRecord[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const decisions = await authz.checkAll(principal, batch.map((tenant) => ({ permission: TENANT_ENTER, resource: tenantResource(tenant.id) })));
    out.push(...batch.filter((_, i) => decisions[i]?.allowed === true));
    batch = [];
  };
  for await (const tenant of (await tenantRegistry()).list({ states: ['active'] })) {
    // A registry may ignore the filter; forEachTenant checks the state again for the same reason.
    if (tenant.state !== 'active') continue;
    batch.push(tenant);
    if (batch.length === CHECK_BATCH) await flush();
  }
  await flush();
  return out;
}
