/** Test DB fixture: boots an Orm in a child DI container on sqlite `:memory:` or on a throwaway Postgres database. */
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Class, ClassInfo, DI, IContainer } from '@spinajs/di';
import '@spinajs/log';
import { DiRegistryMigrationSource, MIGRATION_DESCRIPTION_SYMBOL, MigrationSource, Orm, OrmDriver, OrmMigration, QueryContext } from '@spinajs/orm';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { randomBytes } from 'node:crypto';

import '../../src/migrations/index.js';

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
  /** The `'default'` connection, which the authn-orm migrations and stores use. */
  driver: OrmDriver;
  /** Postgres only: the database created for this run. */
  database?: string;
  dispose(): Promise<void>;
}

export interface BootOptions {
  /** `Migration.OnStartup` of the connection; default true. */
  migrate?: boolean;
  /**
   * Migrations for this boot only, run on `'default'`. Leave them undecorated: `@Migration` registers a class for
   * every Orm in the process.
   */
  migrations?: Class<OrmMigration>[];
  /** Deep-merged into the configuration, e.g. `{ authn: { mfa: { encryptionKey: { secret } } } }`. */
  config?: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    target[key] = isPlainObject(value) && isPlainObject(target[key]) ? deepMerge({ ...(target[key] as Record<string, unknown>) }, value) : value;
  }
  return target;
}

function configurationFor(connection: Record<string, unknown>, extra: Record<string, unknown>) {
  return class TestDbConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();

      const config = this.Config as Record<string, unknown>;
      deepMerge(config, extra);
      // replaced, not merged: package configs must not add connections here
      config.db = { ...(config.db as object), DefaultConnection: connection.Name, Connections: [connection] };
    }
  };
}

function migrationSourceFor(extra: Class<OrmMigration>[]) {
  for (const type of extra) {
    if (!Object.prototype.hasOwnProperty.call(type, MIGRATION_DESCRIPTION_SYMBOL)) {
      (type as unknown as Record<symbol, unknown>)[MIGRATION_DESCRIPTION_SYMBOL] = { Connection: 'default' };
    }
  }

  // Extends the registry source because a child-owned MigrationSource list hides the root's sources.
  return class TestMigrationSource extends DiRegistryMigrationSource {
    public async getMigrations(): Promise<Array<ClassInfo<OrmMigration>>> {
      return [...(await super.getMigrations()), ...extra.map((type) => ({ file: '<test>', name: type.name, type }))];
    }
  };
}

/** Runs plain SQL (`?` placeholders); `executeOnDb` lives on the SQL drivers, not on `OrmDriver`. */
export function rawQuery(driver: OrmDriver, sql: string, bindings: unknown[] = [], context: QueryContext = QueryContext.Select): Promise<any> {
  return (driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<any> }).executeOnDb(sql, bindings, context);
}

async function adminDriver(): Promise<OrmDriver> {
  const container = DI.child();
  const driver = await container.resolve<OrmDriver>(PostgresOrmDriver, [{ Name: 'n4-pg-admin', Driver: 'orm-driver-postgres', ...PG_SERVER, Pool: { Max: 1, AcquireTimeout: PG_ACQUIRE_TIMEOUT } }]);
  await driver.connect();
  return driver;
}

/** Throws when Postgres is unreachable and `N4_REQUIRE_PG=1`; otherwise skips the calling suite. */
export async function requirePostgres(ctx: Mocha.Context): Promise<void> {
  try {
    const admin = await adminDriver();
    await admin.disconnect();
  } catch (err) {
    if (process.env.N4_REQUIRE_PG === '1') {
      throw new Error(`Postgres at ${PG_SERVER.Host}:${PG_SERVER.Port} is unreachable and N4_REQUIRE_PG=1: ${(err as Error).message}`);
    }

    console.warn(`      Postgres at ${PG_SERVER.Host}:${PG_SERVER.Port} is unreachable, suite skipped (set N4_REQUIRE_PG=1 to fail instead)`);
    ctx.skip();
  }
}

export async function createPgDatabase(suite: string): Promise<string> {
  const name = `n4_${suite}_${randomBytes(4).toString('hex')}`;
  const admin = await adminDriver();

  try {
    await admin.schema().createDatabase(name);
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
 * Call from a `before()` hook. For Postgres, skips the suite (see {@link requirePostgres}) and creates a database
 * named after `suite`, dropped again by `dispose()`.
 */
export async function bootDb(ctx: Mocha.Context, kind: DbKind, suite: string, options: BootOptions = {}): Promise<TestDb> {
  DI.setESMModuleSupport();

  const migration = { OnStartup: options.migrate ?? true };
  let database: string | undefined;
  let connection: Record<string, unknown>;

  if (kind === 'postgres') {
    await requirePostgres(ctx);
    database = await createPgDatabase(suite);
    connection = { Name: `n4-${suite}`, Driver: 'orm-driver-postgres', ...PG_SERVER, Database: database, Migration: migration, Pool: { AcquireTimeout: PG_ACQUIRE_TIMEOUT } };
  } else {
    connection = { Name: `n4-${suite}`, Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: migration };
  }

  const container: IContainer = DI.child();
  container.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  container.register(configurationFor(connection, options.config ?? {})).as(Configuration);
  container.register(SqliteOrmDriver).as('orm-driver-sqlite');
  container.register(PostgresOrmDriver).as('orm-driver-postgres');
  if (options.migrations?.length) {
    container.register(migrationSourceFor(options.migrations)).as(MigrationSource);
  }

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
    database,
    dispose: async () => {
      try {
        await orm.dispose();
      } finally {
        if (database) {
          await dropPgDatabase(database);
        }
      }
    },
  };
}
