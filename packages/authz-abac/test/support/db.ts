/** Test DB fixture: an Orm in a child DI container on SQLite `:memory:` or a throwaway Postgres database, with authz_policy. */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import '@spinajs/log';
import { ModelHydrator, Orm, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { randomBytes } from 'node:crypto';

import { AuthzAbac_2026_10_01_00_00_00 } from '../../src/index.js';

/** Array.ofType of the @spinajs/di the tests resolve with, captured before a configuration load can re-patch it. */
const { ofType, chainOf } = Array;

export type DbKind = 'sqlite' | 'postgres';

export const DB_KINDS: readonly DbKind[] = ['sqlite', 'postgres'];

const PG_SERVER = { Host: '127.0.0.1', Port: Number(process.env.ORM_TEST_POSTGRES_PORT ?? 15432), User: 'postgres', Password: 'postgres', Database: 'test' };

/** The shared server can be slow to answer while other lanes load it. */
const PG_ACQUIRE_TIMEOUT = 15000;

export interface TestDb {
  readonly kind: DbKind;
  readonly orm: Orm;
  /** The child container the Orm was resolved in. */
  readonly container: IContainer;
  /** The connection db.Aliases.authz names, with authz_policy. */
  readonly driver: OrmDriver;
  /** Another SQLite `:memory:` connection, without authz_policy. */
  readonly second: OrmDriver;
  dispose(): Promise<void>;
}

/** Runs plain SQL (`?` placeholders); `executeOnDb` lives on the SQL drivers, not on `OrmDriver`. */
export function rawQuery(driver: OrmDriver, sql: string, bindings: unknown[] = [], context: QueryContext = QueryContext.Select): Promise<any> {
  return (driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<any> }).executeOnDb(sql, bindings, context);
}

async function adminDriver(): Promise<OrmDriver> {
  const driver = await DI.child().resolve<OrmDriver>(PostgresOrmDriver, [{ Name: 'abac-pg-admin', Driver: 'orm-driver-postgres', ...PG_SERVER, Pool: { Max: 1, AcquireTimeout: PG_ACQUIRE_TIMEOUT } }]);
  await driver.connect();
  return driver;
}

/** Throws when Postgres is unreachable and `L2_REQUIRE_PG=1`; otherwise skips the calling suite. */
async function requirePostgres(ctx: Mocha.Context): Promise<void> {
  try {
    const admin = await adminDriver();
    await admin.disconnect();
  } catch (err) {
    if (process.env.L2_REQUIRE_PG === '1') {
      throw new Error(`Postgres at ${PG_SERVER.Host}:${PG_SERVER.Port} is unreachable and L2_REQUIRE_PG=1: ${(err as Error).message}`);
    }

    console.warn(`      Postgres at ${PG_SERVER.Host}:${PG_SERVER.Port} is unreachable, suite skipped (set L2_REQUIRE_PG=1 to fail instead)`);
    ctx.skip();
  }
}

async function createPgDatabase(suite: string): Promise<string> {
  const name = `abac_${suite}_${randomBytes(4).toString('hex')}`;
  const admin = await adminDriver();

  try {
    await admin.schema().createDatabase(name);
  } finally {
    await admin.disconnect();
  }

  return name;
}

async function dropPgDatabase(name: string): Promise<void> {
  const admin = await adminDriver();

  try {
    await rawQuery(admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, [], QueryContext.Schema);
  } finally {
    await admin.disconnect();
  }
}

/**
 * Call from a `before()` hook. Boots an Orm whose alias `authz` names the test connection and creates
 * authz_policy there. For Postgres, skips the suite (see {@link requirePostgres}) and creates a database
 * that `dispose()` drops.
 */
export async function bootDb(ctx: Mocha.Context, kind: DbKind, suite: string): Promise<TestDb> {
  DI.setESMModuleSupport();
  // A checkout nested in another one loads a second @spinajs/di through the outer node_modules configs, which re-patches
  // Array.ofType; a list first resolved after that comes back empty, so the hydrators are resolved before the boot.
  DI.resolve(Array.ofType(ModelHydrator));

  const name = `abac-${suite}`;
  const secondName = `${name}-second`;
  let database: string | undefined;
  let connection: Record<string, unknown>;

  if (kind === 'postgres') {
    await requirePostgres(ctx);
    database = await createPgDatabase(suite);
    connection = { Name: name, Driver: 'orm-driver-postgres', ...PG_SERVER, Database: database, Migration: { OnStartup: false }, Pool: { AcquireTimeout: PG_ACQUIRE_TIMEOUT } };
  } else {
    connection = { Name: name, Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: false } };
  }

  const connections = [connection, { Name: secondName, Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: false } }];

  class TestDbConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();

      // Replaced, not merged: package configs must not add connections here.
      const config = this.Config as Record<string, unknown>;
      const db = (config.db ?? {}) as { Aliases?: Record<string, string> };
      config.db = { ...db, DefaultConnection: name, Connections: connections, Aliases: { ...db.Aliases, authz: name } };
    }
  }

  const container = DI.child();
  container.register(TestDbConfiguration).as(Configuration);
  container.register(SqliteOrmDriver).as('orm-driver-sqlite');
  container.register(PostgresOrmDriver).as('orm-driver-postgres');

  try {
    await container.resolve(Configuration);
    // Restores Array.ofType/chainOf if loading the configuration pulled in a second copy of @spinajs/di.
    Object.assign(Array, { ofType, chainOf });
    const orm = await container.resolve(Orm);
    const driver = orm.Connections.get('authz')!;

    // By hand, as authz-testing's e2e harness does: the boot migration pass is not what these suites test.
    await new AuthzAbac_2026_10_01_00_00_00().up(driver);
    // The Orm read the table info before authz_policy existed.
    await orm.reloadTableInfo();

    return {
      kind,
      orm,
      container,
      driver,
      second: orm.Connections.get(secondName)!,
      dispose: async () => {
        await orm.dispose();

        if (database) {
          await dropPgDatabase(database);
        }
      },
    };
  } catch (err) {
    if (database) {
      await dropPgDatabase(database);
    }
    throw err;
  }
}
