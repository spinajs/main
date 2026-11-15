import '@spinajs/orm-mysql';
import '@spinajs/orm-postgres';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { bootIdempotencyApp, sqlite } from '../support/app.js';

const env = process.env;

export interface RealDbTarget {
  name: 'postgres' | 'mysql';
  enabled: boolean;
  connection: Record<string, unknown>;
}

export const REAL_DB_TARGETS: RealDbTarget[] = [
  {
    name: 'postgres',
    enabled: !!env.SPINAJS_TEST_PG_HOST,
    connection: {
      Driver: 'orm-driver-postgres',
      Host: env.SPINAJS_TEST_PG_HOST,
      Port: Number(env.SPINAJS_TEST_PG_PORT ?? 5432),
      User: env.SPINAJS_TEST_PG_USER ?? 'postgres',
      Password: env.SPINAJS_TEST_PG_PASSWORD ?? 'postgres',
      Database: env.SPINAJS_TEST_PG_DB ?? 'spinajs_idempotency_test',
    },
  },
  {
    name: 'mysql',
    enabled: !!env.SPINAJS_TEST_MYSQL_HOST,
    connection: {
      Driver: 'orm-driver-mysql',
      Host: env.SPINAJS_TEST_MYSQL_HOST,
      Port: Number(env.SPINAJS_TEST_MYSQL_PORT ?? 3306),
      User: env.SPINAJS_TEST_MYSQL_USER ?? 'root',
      Password: env.SPINAJS_TEST_MYSQL_PASSWORD ?? '',
      Database: env.SPINAJS_TEST_MYSQL_DB ?? 'spinajs_idempotency_test',
    },
  },
];

const MIGRATIONS_TABLE = 'idempotency_it_migrations';

const realConnection = (target: RealDbTarget, migrate: boolean): Record<string, unknown> => ({
  ...target.connection,
  Name: 'it',
  Migration: { OnStartup: migrate, Table: MIGRATIONS_TABLE, Transaction: { Mode: MigrationTransactionMode.PerMigration } },
});

/** Drops the table and its migration log, then boots again so the migration recreates them. */
export async function bootRealDb(target: RealDbTarget): Promise<TestApp> {
  // While cleaning up, the model stays on SQLite: MySQL refuses to describe a model whose table is missing.
  const cleanup = await bootIdempotencyApp({ db: { DefaultConnection: 'sqlite', Connections: [realConnection(target, false), sqlite('sqlite')], Aliases: { idempotency: 'default' } } });
  const driver = (await cleanup.resolve(Orm)).Connections.get('it') as OrmDriver;
  for (const table of ['__idempotency', MIGRATIONS_TABLE]) {
    await driver.schema().dropTable(table).ifExists();
  }
  await cleanup.dispose();

  return bootIdempotencyApp({ db: { DefaultConnection: 'it', Connections: [realConnection(target, true)], Aliases: { idempotency: 'default' } } });
}
