import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { ConnectionSessionSettings, Orm, sqlDialectOf } from '@spinajs/orm';
import type { OrmDriver, QueryBuilder, SessionSettings } from '@spinajs/orm';
import { tenantScope } from '@spinajs/tenancy';
import type { TenantScope } from '@spinajs/tenancy';

import { TENANT_RLS_SETTINGS } from './rls.js';
import { carriesTenantSettings, scopeKey } from './transaction.js';

/** PostgreSQL and PGlite: the dialects with transaction-local settings and row level security. */
function speaksPostgres(driver: OrmDriver): boolean {
  return sqlDialectOf(driver.constructor as abstract new (...args: never[]) => unknown)?.grammar === 'PostgresQL';
}

/** A read replica holds its primary's tables and policies, and model selects run on it; the models name the primary. */
function primaryOf(driver: OrmDriver): OrmDriver {
  const orm = DI.get(Orm);
  for (const [name, replicas] of orm?.Replicas ?? new Map<string, OrmDriver[]>()) {
    if (replicas.includes(driver)) return orm?.Connections.get(name) ?? driver;
  }
  return driver;
}

/** Whether statements on `driver` tell the database the tenant of their scope. */
export function sendsTenantSettings(driver: OrmDriver): boolean {
  const primary = primaryOf(driver);
  return carriesTenantSettings(primary) && speaksPostgres(primary);
}

/**
 * The tenant of the scope, for the policies `generateTenantRls()` writes. Outside a scope it sends nothing, and the
 * policies show no row. It runs no query.
 */
@Injectable(ConnectionSessionSettings)
export class TenantSessionSettings extends ConnectionSessionSettings {
  settings(driver: OrmDriver): Promise<SessionSettings | undefined> {
    const scope = tenantScope();
    if (scope === undefined || !sendsTenantSettings(driver)) return Promise.resolve(undefined);
    if (scope.kind === 'all') return Promise.resolve({ [TENANT_RLS_SETTINGS.tenant]: '', [TENANT_RLS_SETTINGS.all]: 'on' });
    return Promise.resolve({ [TENANT_RLS_SETTINGS.tenant]: scope.tenant.id, [TENANT_RLS_SETTINGS.all]: 'off' });
  }
}

/** The database learns the scope at BEGIN from the ambient scope, so a statement's own `.acrossTenants()` cannot widen what it shows. */
export function refuseEscapeUnderRls(query: QueryBuilder, statement: TenantScope, name: string): void {
  const ambient = tenantScope();
  if (statement.kind !== 'all' || ambient?.kind === 'all' || !sendsTenantSettings(query.Driver)) return;
  throw new InvalidOperation(
    `tenancy-orm: ${name} leaves the tenant scope with .acrossTenants() on connection ${query.Driver.Options.Name}, whose row level security still sees ${scopeKey(ambient)}; run it inside runAcrossTenants(reason)`,
  );
}
