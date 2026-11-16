import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import type { ITenantAsyncStorage, TenantRef, TenantScope } from './contracts.js';
import { TenantRequired, TenantSwitchDenied } from './errors.js';

type TenantStore = ITenantAsyncStorage & Record<string, unknown>;

/** Called before a change of scope; a throw refuses it. `undefined` is "no scope". */
export type TenantScopeGuard = (from: TenantScope | undefined, to: TenantScope | undefined) => void;

export const TENANT_ID_PATTERN = '^[a-z0-9_-]{1,64}$';

const TENANT_ID = new RegExp(TENANT_ID_PATTERN);

const guards = new Set<TenantScopeGuard>();

// Resolved on every call, never cached: see packages/log/src/context.ts.
function storage(): AsyncLocalStorage<TenantStore> {
  return DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<TenantStore>;
}

export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && TENANT_ID.test(value);
}

export function tenantRef(tenant: TenantRef | string): TenantRef {
  const id: unknown = typeof tenant === 'string' ? tenant : tenant?.id;
  if (!isTenantId(id)) {
    throw new InvalidArgument('a tenant id is 1 to 64 characters of a-z, 0-9, "_" and "-"', 'tenant');
  }
  return Object.freeze({ id });
}

export function tenantScopeOf(tenant: TenantRef | string): TenantScope {
  const scope: TenantScope = { kind: 'tenant', tenant: tenantRef(tenant) };
  return Object.freeze(scope);
}

export function allTenantsScope(reason: string): TenantScope {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text === '') {
    throw new InvalidArgument('a cross-tenant scope needs a reason', 'reason');
  }
  const scope: TenantScope = { kind: 'all', reason: text };
  return Object.freeze(scope);
}

// The store is shared and untyped at run time, so a key another package wrote is checked before it is trusted.
function isScope(value: unknown): value is TenantScope {
  if (value === null || typeof value !== 'object') return false;
  const scope = value as { kind?: unknown; tenant?: { id?: unknown } | null; reason?: unknown };
  if (scope.kind === 'all') return typeof scope.reason === 'string' && scope.reason !== '';
  return scope.kind === 'tenant' && isTenantId(scope.tenant?.id);
}

export function tenantScope(): TenantScope | undefined {
  const scope: unknown = storage().getStore()?.Tenant;
  return isScope(scope) ? scope : undefined;
}

export function currentTenant(): TenantRef | undefined {
  const scope = tenantScope();
  return scope?.kind === 'tenant' ? scope.tenant : undefined;
}

export function requireTenant(): TenantRef {
  const scope = tenantScope();
  if (scope?.kind === 'tenant') return scope.tenant;
  throw new TenantRequired(
    scope ? `this code needs one tenant and runs across all tenants (${scope.reason}); enter one with runInTenant()` : 'this code needs a tenant scope and runs with none; enter one with runInTenant()',
  );
}

export function onTenantScopeChange(guard: TenantScopeGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

/**
 * Replaces the ambient scope for `fn`, whatever it is. For entry-point glue only (a queue consumer, a scheduler run),
 * which carries the scope of a unit of work that started elsewhere; not exported from the package root.
 */
export async function establishTenantScope<T>(scope: TenantScope | undefined, fn: () => Promise<T>): Promise<T> {
  const from = tenantScope();
  for (const guard of guards) guard(from, scope);

  const als = storage();
  const { Tenant: _replaced, ...rest } = als.getStore() ?? {};
  const store: TenantStore = scope ? { ...rest, Tenant: scope } : rest;
  return als.run(store, async () => fn());
}

export async function runInTenant<T>(tenant: TenantRef | string, fn: () => Promise<T>): Promise<T> {
  const target = tenantRef(tenant);
  const current = tenantScope();

  if (current?.kind === 'tenant' && current.tenant.id === target.id) return fn();
  if (current?.kind === 'tenant') {
    throw new TenantSwitchDenied(`cannot switch from tenant "${current.tenant.id}" to tenant "${target.id}"; leave the scope with runAcrossTenants(reason) first`);
  }
  return establishTenantScope(tenantScopeOf(target), fn);
}

export async function runAcrossTenants<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return establishTenantScope(allTenantsScope(reason), fn);
}
