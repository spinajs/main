import '@spinajs/log';
import '@spinajs/orm-sqlite';
import { MigrationTransactionMode } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
// registers the configuration schema and the query middleware before the Orm resolves
import '../../src/index.js';
import './models.js';

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };

const SQLITE = { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } };

/** One ORM over sqlite `:memory:`, migrated by `migrateTestDatabase()`. `tenancy` is the suite's `tenancy` configuration. */
export async function bootApp(tenancy?: Record<string, unknown>): Promise<TestApp> {
  const app = await createTestApp({
    config: { logger: SILENT, db: { DefaultConnection: 'sqlite', Connections: [SQLITE], Aliases: { tenancy: 'default' } }, ...(tenancy ? { tenancy } : {}) },
  });

  try {
    await migrateTestDatabase(app.container);
  } catch (err) {
    await app.dispose();
    throw err;
  }

  return app;
}
