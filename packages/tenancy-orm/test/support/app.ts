import '@spinajs/log';
import '@spinajs/orm-sqlite';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
// registers the package's query middleware before the Orm resolves
import '../../src/index.js';
import './models.js';

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };

const SQLITE = { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } };

/** One ORM over sqlite `:memory:`, migrated on startup. `tenancy` is the suite's `tenancy` configuration. */
export function bootApp(tenancy?: Record<string, unknown>): Promise<TestApp> {
  return createTestApp({
    config: { logger: SILENT, db: { DefaultConnection: 'sqlite', Connections: [SQLITE] }, ...(tenancy ? { tenancy } : {}) },
    resolve: [Orm],
  });
}
