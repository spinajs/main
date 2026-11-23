import { extractModelDescriptor } from '@spinajs/orm';
import type { OrmDriver, QueryBuilder } from '@spinajs/orm';
import { TenantSwitchDenied } from '@spinajs/tenancy';
import type { TenantScope } from '@spinajs/tenancy';

import { rlsModels } from './registry.js';

// The scope the first statement on a tenant table of each open transaction ran in.
const pinned = new WeakMap<object, string>();

export function scopeKey(scope: TenantScope | undefined): string {
  if (scope === undefined) return 'none';
  return scope.kind === 'all' ? 'all' : `tenant:${scope.tenant.id}`;
}

export function scopeChanged(from: string, to: string, driver: OrmDriver): TenantSwitchDenied {
  return new TenantSwitchDenied(`tenancy-orm: the tenant scope changed from ${from} to ${to} inside an open transaction on connection ${driver.Options.Name}; a connection that carries tenant session settings keeps one scope per transaction`);
}

/** Whether statements on `driver` run under tenant session settings: a tenant model on it declares row level security. */
export function carriesTenantSettings(driver: OrmDriver): boolean {
  return rlsModels().some((model) => extractModelDescriptor(model)?.Driver === driver);
}

/**
 * T4: the session settings of a transaction are applied once, at BEGIN, so every statement of it on a tenant table runs
 * in the scope of the first. A statement on a shared table reads no tenant setting and pins nothing.
 */
export function keepOneScopePerTransaction(query: QueryBuilder, scope: TenantScope | undefined): void {
  const driver = query.Driver;
  const transaction = driver.CurrentTransaction;
  if (transaction === undefined || !carriesTenantSettings(driver)) return;
  const key = scopeKey(scope);
  const first = pinned.get(transaction);
  if (first === undefined) pinned.set(transaction, key);
  else if (first !== key) throw scopeChanged(first, key, driver);
}
