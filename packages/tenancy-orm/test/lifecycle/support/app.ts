import '@spinajs/log';
import '@spinajs/orm-sqlite';
import type { IContainer } from '@spinajs/di';
import { MigrationTransactionMode } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
// registers the configuration schema, the query middleware and the lifecycle before the Orm resolves
import { TENANTS_TABLE } from '../../../src/index.js';
import { tenancyDriver } from '../../../src/lifecycle/record.js';
import './models.js';

export const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };

const SQLITE = { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'lc', Migration: { Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } };

/** sqlite in memory on the connection `lc`, which also holds the tenant table; `tenancy` is laid over the suite's. */
export async function bootRowApp(tenancy: Record<string, unknown> = {}, register?: (container: IContainer) => void): Promise<TestApp> {
  const app = await createTestApp({
    config: { logger: SILENT, db: { DefaultConnection: 'lc', Connections: [SQLITE], Aliases: { tenancy: 'lc' } }, tenancy: { registry: 'DbTenantRegistry', registryCacheMs: 0, ...tenancy } },
    ...(register === undefined ? {} : { register }),
  });

  try {
    await migrateTestDatabase(app.container);
  } catch (err) {
    await app.dispose();
    throw err;
  }

  return app;
}

export async function leaseColumns(id: string): Promise<Record<string, unknown>> {
  const rows: unknown = await (await tenancyDriver()).select().from(TENANTS_TABLE).columns(['lifecycle_owner', 'lifecycle_until', 'lifecycle_epoch', 'suspension']).where('id', id);
  const first: unknown = Array.isArray(rows) ? rows[0] : undefined;
  if (first === null || typeof first !== 'object') throw new Error(`no row ${id}`);
  return { ...first };
}

