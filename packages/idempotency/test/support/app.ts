import '@spinajs/log';
import '@spinajs/orm-sqlite';
import type { IContainer } from '@spinajs/di';
import { MigrationTransactionMode } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
// registers the model, the migration and the stores before the Orm resolves
import '../../src/index.js';

export const sqlite = (name: string): Record<string, unknown> => ({
  Driver: 'orm-driver-sqlite',
  Filename: ':memory:',
  Name: name,
  Migration: { Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
});

export const SQLITE_DB = { DefaultConnection: 'sqlite', Connections: [sqlite('sqlite')], Aliases: { idempotency: 'default' } };

export interface IdempotencyAppOptions {
  db?: Record<string, unknown>;
  idempotency?: Record<string, unknown>;
  register?: (container: IContainer) => unknown;
  /** Default true: apply the migrations before anything resolves the Orm. */
  migrate?: boolean;
}

export async function bootIdempotencyApp(options: IdempotencyAppOptions = {}): Promise<TestApp> {
  const app = await createTestApp({
    config: {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      db: options.db ?? SQLITE_DB,
      ...(options.idempotency ? { idempotency: options.idempotency } : {}),
    },
    register: options.register,
  });
  if (options.migrate !== false) await migrateTestDatabase(app.container);
  return app;
}
