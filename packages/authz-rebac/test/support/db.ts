/** Test DB fixture: an Orm in a child DI container on SQLite `:memory:`, with authz_rebac_tuple and authz_change_log on the alias `authz`. */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import '@spinajs/log';
import { Orm, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
// Types only: the drivers load where their dialect runs.
import type { MySqlOrmDriver } from '@spinajs/orm-mysql';
import type { PgliteOrmDriver } from '@spinajs/orm-pglite';
import { randomBytes } from 'node:crypto';
import { AuthzChangeLogHorizon_2026_11_06_00_00_00, AuthzChangeLog_2026_11_04_00_00_00 } from '@spinajs/authz-orm/changelog';

import { AuthzRebac_2026_10_21_00_00_00 } from '../../src/index.js';

export interface TestDb {
  readonly orm: Orm;
  readonly container: IContainer;
  /** The connection db.Aliases.authz names, with authz_rebac_tuple. */
  readonly driver: OrmDriver;
  dispose(): Promise<void>;
}

/** Runs plain SQL (`?` placeholders); `executeOnDb` lives on the SQL drivers, not on `OrmDriver`. */
export function rawQuery(driver: OrmDriver, sql: string, bindings: unknown[] = [], context: QueryContext = QueryContext.Select): Promise<any> {
  return (driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<any> }).executeOnDb(sql, bindings, context);
}

const PG_SERVER = { Host: '127.0.0.1', Port: Number(process.env.ORM_TEST_POSTGRES_PORT ?? 15432), User: 'postgres', Password: 'postgres' };

async function pgAdmin<T>(fn: (admin: OrmDriver) => Promise<T>): Promise<T> {
  const admin = await DI.child().resolve<OrmDriver>(PostgresOrmDriver, [{ Name: 'rebac-pg-admin', Driver: 'orm-driver-postgres', ...PG_SERVER, Database: 'postgres', Pool: { Max: 1 } }]);
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.disconnect();
  }
}

/** A database of its own on the docker Postgres, jit off as a host sets it; skips the suite when the server is unreachable. */
async function createPgDatabase(ctx: Mocha.Context, suite: string): Promise<string> {
  const name = `rebac_${suite}_${randomBytes(4).toString('hex')}`;
  try {
    await pgAdmin(async (admin) => {
      await rawQuery(admin, `CREATE DATABASE "${name}"`, [], QueryContext.Schema);
      await rawQuery(admin, `ALTER DATABASE "${name}" SET jit = off`, [], QueryContext.Schema);
    });
  } catch (err) {
    console.warn(`      Postgres at ${PG_SERVER.Host}:${PG_SERVER.Port} is unreachable, suite skipped: ${(err as Error).message}`);
    ctx.skip();
  }
  return name;
}

export type Dialect = 'sqlite' | 'postgres' | 'pglite' | 'mysql';

export const DIALECTS: readonly Dialect[] = ['sqlite', 'pglite', 'postgres', 'mysql'];

const MYSQL_SERVER = { Host: '127.0.0.1', Port: 13306, User: 'root', Password: 'root' };

/** Runs `sql` on the MySQL test server without a database; skips the calling suite when the server is unreachable. */
async function mysqlAdmin(ctx: Mocha.Context | undefined, sql: string): Promise<void> {
  const { MySqlOrmDriver } = await import('@spinajs/orm-mysql');
  const admin = await DI.child().resolve<OrmDriver>(MySqlOrmDriver, [{ Name: 'rebac-mysql-admin', Driver: 'orm-driver-mysql', ...MYSQL_SERVER, Pool: { Max: 1 } }]);
  try {
    await admin.connect();
  } catch (err) {
    console.warn(`      MySQL at ${MYSQL_SERVER.Host}:${MYSQL_SERVER.Port} is unreachable, suite skipped: ${(err as Error).message}`);
    ctx?.skip();
    throw err;
  }
  try {
    await rawQuery(admin, sql, [], QueryContext.Schema);
  } finally {
    await admin.disconnect();
  }
}

/**
 * Call from a `before()` hook: boots an Orm whose alias `authz` names a fresh SQLite connection (with `postgres`,
 * a fresh database on the docker Postgres, dropped by `dispose()`) and runs the migration there.
 */
export async function bootDb(suite: string, postgres?: Mocha.Context, dialect: Dialect = postgres ? 'postgres' : 'sqlite'): Promise<TestDb> {
  DI.setESMModuleSupport();
  const name = `rebac-${suite}`;
  const database = dialect === 'postgres' && postgres ? await createPgDatabase(postgres, suite.replace(/[^a-z0-9_]/gi, '_')) : undefined;
  const mysqlDatabase = dialect === 'mysql' ? `rebac_${randomBytes(4).toString('hex')}` : undefined;
  if (mysqlDatabase !== undefined) await mysqlAdmin(postgres, `CREATE DATABASE ${mysqlDatabase}`);
  const migration = { OnStartup: false };
  const connection =
    database !== undefined
      ? { Name: name, Driver: 'orm-driver-postgres', ...PG_SERVER, Database: database, Migration: migration }
      : mysqlDatabase !== undefined
        ? { Name: name, Driver: 'orm-driver-mysql', ...MYSQL_SERVER, Database: mysqlDatabase, Migration: migration }
        : { Name: name, Driver: dialect === 'pglite' ? 'orm-driver-pglite' : 'orm-driver-sqlite', Filename: ':memory:', Migration: migration };
  const connections = [connection];
  let extra: typeof PgliteOrmDriver | typeof MySqlOrmDriver | undefined;
  if (dialect === 'pglite') extra = (await import('@spinajs/orm-pglite')).PgliteOrmDriver;
  if (dialect === 'mysql') extra = (await import('@spinajs/orm-mysql')).MySqlOrmDriver;

  class TestDbConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      // Replaced, not merged: package configs must not add connections here.
      const config = this.Config;
      const db = (config.db ?? {}) as { Aliases?: Record<string, string> };
      config.db = { ...db, DefaultConnection: name, Connections: connections, Aliases: { ...db.Aliases, authz: name }, StrictTableCheck: false };
    }
  }

  const container = DI.child();
  container.register(TestDbConfiguration).as(Configuration);
  container.register(SqliteOrmDriver).as('orm-driver-sqlite');
  container.register(PostgresOrmDriver).as('orm-driver-postgres');
  if (extra !== undefined) container.register(extra).as(`orm-driver-${dialect}`);

  await container.resolve(Configuration);
  const orm = await container.resolve(Orm);
  const driver = orm.Connections.get('authz')!;
  // By hand: the boot migration pass is not what these suites test.
  await new AuthzRebac_2026_10_21_00_00_00().up(driver);
  await new AuthzChangeLog_2026_11_04_00_00_00().up(driver);
  await new AuthzChangeLogHorizon_2026_11_06_00_00_00().up(driver);
  // The Orm read the table info before authz_rebac_tuple existed.
  await orm.reloadTableInfo();

  const dispose = async () => {
    await orm.dispose();
    if (database) await pgAdmin((admin) => rawQuery(admin, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`, [], QueryContext.Schema));
    if (mysqlDatabase) await mysqlAdmin(undefined, `DROP DATABASE IF EXISTS ${mysqlDatabase}`);
  };
  return { orm, container, driver, dispose };
}
