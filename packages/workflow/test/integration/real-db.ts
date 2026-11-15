import { DI } from '@spinajs/di';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import '@spinajs/orm-mysql';
import '@spinajs/orm-postgres';
import { bootTestEnv, sqlite, type TestEnvOptions } from '../support/env.js';

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
      Database: env.SPINAJS_TEST_PG_DB ?? 'spinajs_workflow_test',
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
      Database: env.SPINAJS_TEST_MYSQL_DB ?? 'spinajs_workflow_test',
    },
  },
];

const TABLES = ['__workflow_event', '__workflow_step', '__workflow', 'workflow_it_migrations'];

function db(target: RealDbTarget, migrate: boolean) {
  const it = {
    ...target.connection,
    Name: 'it',
    Migration: { OnStartup: migrate, Table: 'workflow_it_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
  };
  // While cleaning up, the models stay on SQLite: MySQL refuses to describe a model whose table is missing.
  return migrate
    ? { DefaultConnection: 'it', Connections: [it, sqlite('queue')], Aliases: { workflow: 'it' } }
    : { DefaultConnection: 'sqlite', Connections: [it, sqlite('sqlite'), sqlite('queue')], Aliases: { workflow: 'sqlite' } };
}

/** Drops the workflow tables, then boots again so the migration recreates them on the real database. */
export async function bootRealDb(target: RealDbTarget, options: TestEnvOptions = {}) {
  await bootTestEnv({ ...options, extra: { ...options.extra, db: db(target, false) } });
  const driver = (await DI.resolve(Orm)).Connections.get('it')!;
  for (const t of TABLES) await driver.schema().dropTable(t).ifExists();
  return bootTestEnv({ ...options, extra: { ...options.extra, db: db(target, true) } });
}
