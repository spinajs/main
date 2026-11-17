import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { onTenantScopeChange } from '@spinajs/tenancy';
import type { TenantScope } from '@spinajs/tenancy';

import { hasTenantModels } from './registry.js';
import { carriesTenantSettings, scopeChanged, scopeKey } from './transaction.js';

/**
 * T4 at the change itself: the scope stays what it is while a transaction is open on a connection that carries tenant
 * settings. Guards are also called for a change to the same kind and tenant, which is no change.
 */
export function refuseScopeChangeInTransaction(from: TenantScope | undefined, to: TenantScope | undefined): void {
  if (!hasTenantModels()) return;
  const before = scopeKey(from);
  const after = scopeKey(to);
  if (before === after) return;
  // Connections lists a driver once per name and alias.
  for (const driver of new Set(DI.get(Orm)?.Connections.values() ?? [])) {
    if (driver.CurrentTransaction !== undefined && carriesTenantSettings(driver)) throw scopeChanged(before, after, driver);
  }
}

// Kept for the life of the process, like the QueryMiddleware registration. The guard asks for the Orm of the moment, so
// it needs neither a boot nor a dispose.
export const stopTransactionScopeGuard = onTenantScopeChange(refuseScopeChangeInTransaction);
