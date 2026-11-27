import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { SHARED_SCOPE } from '@spinajs/configuration-db-source';
import { ConfigScopeRefused } from './errors.js';

// @spinajs/tenancy's id pattern, copied: this package reads the tenant scope from the request store by name.
const TENANT_ID = /^[a-z0-9_-]{1,64}$/;

const field = (value: unknown, key: string): unknown => (value !== null && typeof value === 'object' ? (Reflect.get(value, key) as unknown) : undefined);

/**
 * The `Scope` of the rows a request reaches: `tenant:<id>` inside a tenant scope (written by `TenantMiddleware`),
 * `shared` outside any. A scope across all tenants, or a store value of another shape, names no single scope and is refused.
 */
export function requestScope(): string {
  const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>).getStore();
  const scope = store?.Tenant;
  if (scope === undefined) return SHARED_SCOPE;
  const id = field(field(scope, 'tenant'), 'id');
  if (field(scope, 'kind') === 'tenant' && typeof id === 'string' && TENANT_ID.test(id)) return `tenant:${id}`;
  throw new ConfigScopeRefused('the configuration api serves the rows of one tenant, or the shared rows outside any tenant; this request runs across all tenants');
}

/** Whether `slug` is, or lies below, a path of `tenancy.config.overridable`: the only rows a tenant's overlay serves. */
export function overridableSlug(slug: string, overridable: unknown): boolean {
  return Array.isArray(overridable) && overridable.some((path) => typeof path === 'string' && path !== '' && (slug === path || slug.startsWith(`${path}.`)));
}
