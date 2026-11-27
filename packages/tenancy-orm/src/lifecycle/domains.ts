import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';

import { isTenantDomain } from '../db-registry.js';
import { TenantModel } from '../models/TenantModel.js';

/** Lower-cased, without duplicates; anything that is not a host name is refused. */
export function normalizeDomains(domains: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const raw of domains) {
    const domain = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!isTenantDomain(domain)) throw new InvalidArgument(`tenancy-orm: "${String(raw)}" is not a host name a tenant can answer to`, 'domains');
    out.add(domain);
  }
  return [...out];
}

/** The table cannot make a domain unique (it is a list column), so a write checks it here. */
export async function assertDomainsFree(id: string, domains: readonly string[]): Promise<void> {
  // spinajs-orm-ignore ORM102: one lookup per domain of one tenant, a handful
  for (const domain of domains) {
    const [holder] = await TenantModel.query().whereInSet('domains', [domain]).where('id', '!=', id).where('state', '!=', 'deleted').take(1);
    if (holder !== undefined) throw new ResourceDuplicated(`tenancy-orm: the domain "${domain}" belongs to tenant "${holder.id}"`);
  }
}
