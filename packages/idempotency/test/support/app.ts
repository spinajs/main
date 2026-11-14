import '@spinajs/log';
import '@spinajs/orm-sqlite';
import type { IContainer } from '@spinajs/di';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
// registers the model, the migration and the stores before the Orm resolves
import '../../src/index.js';

export const sqlite = (name: string): Record<string, unknown> => ({
  Driver: 'orm-driver-sqlite',
  Filename: ':memory:',
  Name: name,
  Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
});

export const SQLITE_DB = { DefaultConnection: 'sqlite', Connections: [sqlite('sqlite')], Aliases: { idempotency: 'default' } };

export interface IdempotencyAppOptions {
  db?: Record<string, unknown>;
  idempotency?: Record<string, unknown>;
  register?: (container: IContainer) => unknown;
}

export function bootIdempotencyApp(options: IdempotencyAppOptions = {}): Promise<TestApp> {
  return createTestApp({
    config: {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      db: options.db ?? SQLITE_DB,
      ...(options.idempotency ? { idempotency: options.idempotency } : {}),
    },
    register: options.register,
    // the Orm resolves its migrator, not the other way round
    resolve: [Orm],
  });
}
