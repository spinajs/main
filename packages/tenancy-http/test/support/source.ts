import type { Principal } from '@spinajs/principal';
import { MemoryTenantRegistry, tenantRegistry } from '@spinajs/tenancy';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import type { TenantRequestSource } from '../../src/index.js';

export const user = (id: string, attributes: Record<string, unknown> = {}): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes });

export const anonymous: Principal = { type: 'anonymous', id: 'anonymous', authenticated: false, source: 'anonymous', attributes: {} };

export const source = (over: Partial<TenantRequestSource> = {}): TenantRequestSource => ({ host: undefined, headers: {}, params: {}, principal: undefined, session: undefined, ...over });

/** A test application on the memory registry; `tenancy` is merged over that. No Bootstrapper runs. */
export function tenancyHttpApp(tenancy: Record<string, unknown> = {}): Promise<TestApp> {
  return createTestApp({ bootstrap: false, config: { tenancy: { registry: 'MemoryTenantRegistry', ...tenancy } } });
}

/** `acme` (slug `acme-inc`, domain `shop.acme.example`, active) and `frozen` (suspended). */
export async function seedTenants(): Promise<MemoryTenantRegistry> {
  const registry = (await tenantRegistry()).inner;
  if (!(registry instanceof MemoryTenantRegistry)) throw new Error('expected the memory registry');
  registry.add({ id: 'acme', slug: 'acme-inc', domains: ['shop.acme.example'] });
  registry.add({ id: 'frozen', state: 'suspended' });
  return registry;
}
