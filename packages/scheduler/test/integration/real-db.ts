import { DI } from '@spinajs/di';
import { MigrationTransactionMode, Orm, QueryContext } from '@spinajs/orm';
import '@spinajs/orm-mysql';
import '@spinajs/orm-postgres';
import { bootTestEnv } from '../support/env.js';

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
      Database: env.SPINAJS_TEST_PG_DB ?? 'spinajs_scheduler_test',
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
      Database: env.SPINAJS_TEST_MYSQL_DB ?? 'spinajs_scheduler_test',
    },
  },
];

const TABLES = [
  '__scheduler_run_log',
  '__scheduler_journal_pos',
  '__scheduler_run_step',
  '__scheduler_run_attempt',
  '__scheduler_error',
  '__scheduler_run',
  '__scheduler',
  'scheduler_it_migrations',
];

const sqlite = (name: string) => ({
  Driver: 'orm-driver-sqlite',
  Filename: ':memory:',
  Name: name,
  Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
});

function db(target: RealDbTarget, migrate: boolean) {
  const it = {
    ...target.connection,
    Name: 'it',
    Migration: {
      OnStartup: migrate,
      Table: 'scheduler_it_migrations',
      Transaction: { Mode: MigrationTransactionMode.PerMigration },
    },
  };
  // While cleaning up, the models stay on SQLite: MySQL refuses to describe a model whose table is missing.
  return migrate
    ? { DefaultConnection: 'it', Connections: [it, sqlite('queue')] }
    : { DefaultConnection: 'sqlite', Connections: [it, sqlite('sqlite'), sqlite('queue')] };
}

/** Drops the scheduler tables, then boots again so the migration recreates them. */
export async function bootRealDb(target: RealDbTarget, scheduler: Record<string, unknown> = {}): Promise<void> {
  await bootTestEnv({ extra: { db: db(target, false) }, scheduler });
  const driver = (await DI.resolve(Orm)).Connections.get('it') as unknown as {
    executeOnDb(sql: string, p: unknown[], c: QueryContext): Promise<unknown>;
  };
  for (const t of TABLES) await driver.executeOnDb(`DROP TABLE IF EXISTS ${t}`, [], QueryContext.Schema);
  await bootTestEnv({ extra: { db: db(target, true) }, scheduler });
}
