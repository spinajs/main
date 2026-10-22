import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Orm } from '@spinajs/orm';
import _ from 'lodash';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgresOrmDriver } from '../../src/index.js';

export const PG_SERVER = {
  Host: process.env.ORM_TEST_POSTGRES_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_POSTGRES_PORT ?? 15432),
  User: process.env.ORM_TEST_POSTGRES_USER ?? 'postgres',
  Password: process.env.ORM_TEST_POSTGRES_PASSWORD ?? 'postgres',
};

export interface PgTestDb {
  name: string;
  orm: Orm;
  driver: PostgresOrmDriver;
  dispose(): Promise<void>;
}

const pgRequired = () => process.env.ORM_TEST_POSTGRES_REQUIRED === '1' || process.env.ORM_TEST_REQUIRE_PG === '1' || process.env.L2_REQUIRE_PG === '1';

export async function adminQuery(sql: string): Promise<void> {
  const client = new pg.Client({ host: PG_SERVER.Host, port: PG_SERVER.Port, user: PG_SERVER.User, password: PG_SERVER.Password, database: 'test', connectionTimeoutMillis: 3000 });
  await client.connect();

  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Call from a `before()` hook: skips the suite when Postgres is down, fails it under ORM_TEST_REQUIRE_PG=1. */
export async function requirePostgres(ctx: Mocha.Context): Promise<void> {
  try {
    await adminQuery('SELECT 1');
  } catch (err) {
    if (pgRequired()) {
      throw new Error(`Postgres at ${PG_SERVER.Host}:${PG_SERVER.Port} is unreachable and ORM_TEST_REQUIRE_PG=1: ${(err as Error).message}`, { cause: err });
    }

    console.warn(`      Postgres at ${PG_SERVER.Host}:${PG_SERVER.Port} is unreachable, suite skipped (set ORM_TEST_REQUIRE_PG=1 to fail instead)`);
    ctx.skip();
  }
}

/**
 * Creates a throwaway database and boots an Orm on it as connection `pg`. `dispose()` closes the
 * connection, unregisters the configuration and drops the database.
 *
 * @param suite - lower-case letters, digits and underscores; part of the database name
 */
export async function bootPostgres(suite: string): Promise<PgTestDb> {
  const name = `orm_${suite}_${randomBytes(4).toString('hex')}`;
  await adminQuery(`CREATE DATABASE "${name}"`);

  class PgSupportConf extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();

      _.mergeWith(
        this.Config,
        {
          logger: {
            targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
            rules: [{ name: '*', level: 'error', target: 'Empty' }],
          },
          db: {
            // Every suite creates its own table after the boot, in a database that never has the other suites' tables.
            StrictTableCheck: false,
            Migration: { Startup: false },
            Connections: [{ Driver: 'orm-driver-postgres', Name: 'pg', ...PG_SERVER, Database: name, Migration: { OnStartup: false } }],
          },
        },
        (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined),
      );
    }
  }

  DI.clearCache();
  DI.register(PgSupportConf).as(Configuration);
  DI.register(PostgresOrmDriver).as('orm-driver-postgres');

  const orm = await DI.resolve(Orm);
  const driver = orm.Connections.get('pg') as PostgresOrmDriver;

  return {
    name,
    orm,
    driver,
    dispose: async () => {
      await driver.disconnect();
      DI.clearCache();
      // DI resolves the last registration of a token; left registered, this configuration
      // would point the next suite at a dropped database.
      DI.unregister(PgSupportConf);
      await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}
