/** Test DB fixture: boots an Orm in a child DI container on sqlite `:memory:` or on a throwaway Postgres database. */
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, IContainer } from '@spinajs/di';
import '@spinajs/log';
import { Orm, OrmDriver, QueryContext } from '@spinajs/orm';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { randomBytes } from 'node:crypto';

export type DbKind = 'sqlite' | 'postgres';

export const DB_KINDS: DbKind[] = ['sqlite', 'postgres'];

export const PG_SERVER = { Host: '127.0.0.1', Port: 15432, User: 'postgres', Password: 'postgres', Database: 'test' };

/** The shared server can be slow to answer while other lanes load it. */
const PG_ACQUIRE_TIMEOUT = 15000;

export interface TestDb {
  kind: DbKind;
  orm: Orm;
  /** The child container the Orm was resolved in; resolve stores from it. */
  container: IContainer;
  /** The connection the authz-rbac migrations and stores use (`'default'`). */
  driver: OrmDriver;
  /** Postgres only: the database created for this run. */
  database?: string;
  /** With `second: true`: another SQLite `:memory:` connection, without migrations. */
  second?: OrmDriver;
  dispose(): Promise<void>;
}

export interface BootOptions {
  /** `Migration.OnStartup` of the connection; default true. */
  migrate?: boolean;
  /** Also boot a second connection (`TestDb.second`). */
  second?: boolean;
}

function configurationFor(connection: Record<string, unknown>, extra: Record<string, unknown>[]) {
  return class TestDbConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();

      // replaced, not merged: package configs must not add connections here
      const config = this.Config as Record<string, unknown>;
      config.db = { ...(config.db as object), DefaultConnection: connection.Name, Connections: [connection, ...extra] };
    }
  };
}

/** Runs plain SQL (`?` placeholders); `executeOnDb` lives on the SQL drivers, not on `OrmDriver`. */
export function rawQuery(driver: OrmDriver, sql: string, bindings: unknown[] = [], context: QueryContext = QueryContext.Select): Promise<any> {
  return (driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<any> }).executeOnDb(sql, bindings, context);
}

async function adminDriver(): Promise<OrmDriver> {
  const container = DI.child();
  const driver = await container.resolve<OrmDriver>(PostgresOrmDriver, [{ Name: 'l2-pg-admin', Driver: 'orm-driver-postgres', ...PG_SERVER, Pool: { Max: 1, AcquireTimeout: PG_ACQUIRE_TIMEOUT } }]);
  await driver.connect();
  return driver;
}

/**
 * Throws when Postgres is unreachable and `L2_REQUIRE_PG=1`; otherwise skips the calling suite.
 */
export async function requirePostgres(ctx: Mocha.Context): Promise<void> {
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

export async function createPgDatabase(suite: string): Promise<string> {
  const name = `l2_${suite}_${randomBytes(4).toString('hex')}`;
  const admin = await adminDriver();

  try {
    await admin.schema().createDatabase(name);
    // authz-orm refuses a connection with jit on unless authz.orm.allowJit; a host turns jit off like this.
    await rawQuery(admin, `ALTER DATABASE "${name}" SET jit = off`, [], QueryContext.Schema);
  } finally {
    await admin.disconnect();
  }

  return name;
}

export async function dropPgDatabase(name: string): Promise<void> {
  const admin = await adminDriver();

  try {
    await rawQuery(admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, [], QueryContext.Schema);
  } finally {
    await admin.disconnect();
  }
}

/**
 * Call from a `before()` hook. For Postgres, skips the suite (see {@link requirePostgres}) and
 * creates a database named after `suite`, dropped again by `dispose()`.
 */
export async function bootDb(ctx: Mocha.Context, kind: DbKind, suite: string, options: BootOptions = {}): Promise<TestDb> {
  DI.setESMModuleSupport();

  const migration = { OnStartup: options.migrate ?? true };
  let database: string | undefined;
  let connection: Record<string, unknown>;

  if (kind === 'postgres') {
    await requirePostgres(ctx);
    database = await createPgDatabase(suite);
    connection = { Name: `l2-${suite}`, Driver: 'orm-driver-postgres', ...PG_SERVER, Database: database, Migration: migration, Pool: { AcquireTimeout: PG_ACQUIRE_TIMEOUT } };
  } else {
    connection = { Name: `l2-${suite}`, Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: migration };
  }

  const container: IContainer = DI.child();
  const second = options.second ? [{ Name: `l2-${suite}-second`, Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: false } }] : [];
  // The test database boots as an app does: the core schema gives authz.admin.connection its default.
  container.register(AUTHZ_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  container.register(configurationFor(connection, second)).as(Configuration);
  container.register(SqliteOrmDriver).as('orm-driver-sqlite');
  container.register(PostgresOrmDriver).as('orm-driver-postgres');

  let orm: Orm;

  try {
    await container.resolve(Configuration);
    orm = await container.resolve(Orm);
  } catch (err) {
    if (database) {
      await dropPgDatabase(database);
    }
    throw err;
  }

  return {
    kind,
    orm,
    container,
    driver: orm.Connections.get('default')!,
    second: second.length > 0 ? orm.Connections.get(`l2-${suite}-second`) : undefined,
    database,
    dispose: async () => {
      await orm.dispose();

      if (database) {
        await dropPgDatabase(database);
      }
    },
  };
}
