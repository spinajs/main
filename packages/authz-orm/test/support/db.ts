import '@spinajs/log';
import '@spinajs/orm-sqlite';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';

import { randomBytes } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';

import { unregisterResource } from '../../src/registry.js';

export type Dialect = 'sqlite' | 'postgres' | 'pglite' | 'mysql';

/** A connection of the test ORM: a dialect, or `other`, a second SQLite `:memory:` database. */
export type ConnectionName = Dialect | 'other';

export const POSTGRES = { Host: 'localhost', Port: Number(process.env.ORM_TEST_POSTGRES_PORT ?? 15432), User: 'postgres', Password: 'postgres' };
export const MYSQL = { Host: '127.0.0.1', Port: 13306, User: 'root', Password: 'root' };

/** Runs `sql` on the MySQL test server without a database, to make or drop the one a TestDb uses. */
async function mysqlAdmin(sql: string): Promise<void> {
  // Loaded only where a MySQL dialect runs, as the PGlite driver is: most suites never open either.
  const { MySqlOrmDriver } = await import('@spinajs/orm-mysql');
  const admin = await DI.child().resolve<OrmDriver>(MySqlOrmDriver, [{ Name: 'authz-orm-mysql-admin', Driver: 'orm-driver-mysql', ...MYSQL, Pool: { Max: 1 } }]);
  await admin.connect();
  try {
    await adminSql(admin, sql);
  } finally {
    await admin.disconnect();
  }
}

async function withPostgresAdmin<T>(fn: (admin: OrmDriver) => Promise<T>): Promise<T> {
  const admin = await DI.child().resolve<OrmDriver>(PostgresOrmDriver, [{ Name: 'authz-orm-pg-admin', Driver: 'orm-driver-postgres', ...POSTGRES, Database: 'postgres', Pool: { Max: 1 } }]);
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.disconnect();
  }
}

const adminSql = (admin: OrmDriver, sql: string): Promise<unknown> =>
  (admin as unknown as { executeOnDb(s: string, p: unknown[], c: QueryContext): Promise<unknown> }).executeOnDb(sql, [], QueryContext.Schema);

/** A new database for one TestDb, with jit off as a host sets it (authz-orm refuses a connection with jit on). */
async function createPostgresDatabase(): Promise<string> {
  const name = `authz_orm_${randomBytes(4).toString('hex')}`;
  await withPostgresAdmin(async (admin) => {
    await adminSql(admin, `CREATE DATABASE "${name}"`);
    await adminSql(admin, `ALTER DATABASE "${name}" SET jit = off`);
  });
  return name;
}

const dropPostgresDatabase = (name: string): Promise<unknown> => withPostgresAdmin((admin) => adminSql(admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));

export interface ModelSpec {
  /** Class name; made unique per definition. */
  readonly name: string;
  /** Column → SQL type; `id` is the primary key, TEXT unless given here. */
  readonly columns: Readonly<Record<string, string>>;
  readonly rows?: readonly Readonly<Record<string, unknown>>[];
  /** Applied to the class before the ORM sees it (authz decorators, `@Json`, …). */
  readonly decorate?: (model: typeof ModelBase, proto: object) => void;
  /** Extends this class instead of ModelBase (decorators already on it are kept). */
  readonly base?: typeof ModelBase;
}

let seq = 0;
const unique = (name: string): string => `${name}_${process.pid}_${++seq}`;

/**
 * One ORM over an in-memory SQLite connection named 'sqlite' and, when asked for, the docker
 * Postgres as 'postgres'. Configuration comes from authz-testing's testHost, so a test can boot the
 * authz host on the same DI root.
 */
export class TestDb {
  private readonly models: { model: typeof ModelBase; table: string; dialect: Dialect }[] = [];
  private ownsInstall = false;
  private restoreConfig: () => void = () => undefined;
  private postgresDatabase: string | undefined;
  private mysqlDatabase: string | undefined;

  private constructor(readonly orm: Orm, readonly dialects: readonly Dialect[]) {}

  static postgresReachable(): Promise<boolean> {
    return TestDb.reachable(POSTGRES.Host, POSTGRES.Port);
  }

  static mysqlReachable(): Promise<boolean> {
    return TestDb.reachable(MYSQL.Host, MYSQL.Port);
  }

  private static async reachable(host: string, port: number): Promise<boolean> {
    const net = await import('node:net');
    return new Promise((resolve) => {
      const s = net.createConnection({ host, port });
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(1000, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
  }

  /** With `postgres`, the 'postgres' connection is a database of its own, dropped by `close()`. */
  static async open(opts: { postgres?: boolean; other?: boolean; pglite?: boolean; mysql?: boolean } = {}): Promise<TestDb> {
    let ownsInstall = false;
    try {
      testHost.config();
    } catch {
      await testHost.installHost();
      ownsInstall = true;
    }
    const cfg = testHost.config();
    const connections: unknown[] = [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' }];
    if (opts.other) connections.push({ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'other' });
    // The orm qualifies a joined Postgres table with the database name as its schema; a schema of
    // that name on the search path makes the joined and the unqualified spelling one table.
    const database = opts.postgres ? await createPostgresDatabase() : undefined;
    if (database !== undefined) connections.push({ Driver: 'orm-driver-postgres', Name: 'postgres', ...POSTGRES, Database: database, Options: { Schema: database } });
    if (opts.pglite) {
      await import('@spinajs/orm-pglite');
      connections.push({ Driver: 'orm-driver-pglite', Name: 'pglite', Filename: ':memory:' });
    }
    const mysqlDatabase = opts.mysql ? `authz_orm_${randomBytes(4).toString('hex')}` : undefined;
    if (mysqlDatabase !== undefined) {
      await mysqlAdmin(`CREATE DATABASE ${mysqlDatabase}`);
      connections.push({ Driver: 'orm-driver-mysql', Name: 'mysql', ...MYSQL, Database: mysqlDatabase });
    }
    const before = { logger: cfg.get<unknown>('logger'), db: cfg.get<unknown>('db') };
    cfg.set('logger', { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] });
    // Suites create and drop the authz tables per test, after the boot (createAncestorTable, createScopeAttributeTables, define).
    cfg.set('db', { DefaultConnection: 'sqlite', Connections: connections, Aliases: { authz: 'default' }, StrictTableCheck: false });

    const restoreConfig = () => {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) cfg.unset(k);
        else cfg.set(k, v);
      }
    };
    let orm: Orm | undefined;
    try {
      orm = await DI.resolve(Orm);
      const db = new TestDb(orm, ['sqlite', ...(opts.postgres ? ['postgres' as const] : []), ...(opts.pglite ? ['pglite' as const] : []), ...(opts.mysql ? ['mysql' as const] : [])]);
      db.ownsInstall = ownsInstall;
      db.restoreConfig = restoreConfig;
      db.postgresDatabase = database;
      db.mysqlDatabase = mysqlDatabase;
      if (database !== undefined) await db.raw(`CREATE SCHEMA IF NOT EXISTS "${database}"`, [], 'postgres');
      return db;
    } catch (e) {
      if (orm) {
        DI.RootContainer.uncache(Orm);
        await orm.dispose().catch(() => undefined);
      }
      restoreConfig();
      if (database !== undefined) await dropPostgresDatabase(database).catch(() => undefined);
      if (mysqlDatabase !== undefined) await mysqlAdmin(`DROP DATABASE IF EXISTS ${mysqlDatabase}`).catch(() => undefined);
      throw e;
    }
  }

  driver(name: ConnectionName = 'sqlite'): OrmDriver {
    const d = this.orm.Connections.get(name);
    if (!d) throw new Error(`TestDb: no connection ${name}`);
    return d;
  }

  /** Points the alias `authz` at `name`, where the authz records then read and write, and reloads every model's columns from its connection. */
  async useAuthz(name: ConnectionName): Promise<void> {
    this.orm.Connections.set(AUTHZ_CONNECTION, this.driver(name));
    await this.orm.reloadTableInfo();
  }

  /** `name` quoted for `dialect`'s SQL. */
  static quote(name: string, dialect: Dialect): string {
    return dialect === 'mysql' ? `\`${name}\`` : `"${name}"`;
  }

  raw(sql: string, params: unknown[] = [], dialect: Dialect = 'sqlite'): Promise<any> {
    return (this.driver(dialect) as unknown as { executeOnDb(s: string, p: unknown[], c: QueryContext): Promise<any> }).executeOnDb(sql, params, QueryContext.Select);
  }

  /** Defines a model class on `dialect`, creates its table and inserts `spec.rows`. */
  async define(spec: ModelSpec, dialect: Dialect = 'sqlite'): Promise<typeof ModelBase & (new () => ModelBase)> {
    const name = unique(spec.name);
    const table = name.toLowerCase();
    const Base = spec.base ?? ModelBase;
    const cls = { [name]: class extends Base {} }[name] as typeof ModelBase & (new () => ModelBase);

    Primary()(cls.prototype, 'id');
    spec.decorate?.(cls, cls.prototype);
    Connection(dialect)(cls);
    Model(table)(cls);

    const q = (n: string) => TestDb.quote(n, dialect);
    const columns = { id: dialect === 'mysql' ? 'VARCHAR(64)' : 'TEXT', ...spec.columns };
    const ddl = Object.entries(columns)
      .map(([c, t]) => `${q(c)} ${t}${c === 'id' ? ' PRIMARY KEY' : ''}`)
      .join(', ');
    await this.raw(`CREATE TABLE ${q(table)} (${ddl})`, [], dialect);
    this.models.push({ model: cls, table, dialect });

    const orm = this.orm as unknown as { registerModel(m: unknown): void; applyModelMixins(): void; wireRelations(): void };
    orm.registerModel(cls);
    orm.wireRelations();
    orm.applyModelMixins();
    await this.orm.reloadTableInfo();

    for (const row of spec.rows ?? []) await this.insertRaw(cls, row);
    return cls;
  }

  /** An unscoped INSERT, bypassing every query middleware. */
  async insertRaw(model: typeof ModelBase, row: Readonly<Record<string, unknown>>): Promise<void> {
    const m = this.find(model);
    const keys = Object.keys(row);
    const params = keys.map((k) => row[k]);
    const q = (n: string) => TestDb.quote(n, m.dialect);
    const marks = m.dialect === 'postgres' || m.dialect === 'pglite' ? keys.map((_, i) => `$${i + 1}`) : keys.map(() => '?');
    await this.raw(`INSERT INTO ${q(m.table)} (${keys.map(q).join(', ')}) VALUES (${marks.join(', ')})`, params, m.dialect);
  }

  /** The raw table, unscoped. */
  async rows(model: typeof ModelBase): Promise<Record<string, unknown>[]> {
    const m = this.find(model);
    return (await this.raw(`SELECT * FROM ${TestDb.quote(m.table, m.dialect)}`, [], m.dialect)) as Record<string, unknown>[];
  }

  table(model: typeof ModelBase): string {
    return this.find(model).table;
  }

  private find(model: typeof ModelBase) {
    const m = this.models.find((x) => x.model === model);
    if (!m) throw new Error(`TestDb: ${model.name} was not defined here`);
    return m;
  }

  /** Drops what `define` created and forgets the classes (ORM model list, DI '__models__', authz registry). */
  async clear(): Promise<void> {
    const ormModels = this.orm.Models as { type: unknown }[];
    for (const m of this.models.splice(0).reverse()) {
      await this.raw(`DROP TABLE IF EXISTS ${TestDb.quote(m.table, m.dialect)}`, [], m.dialect);
      const i = ormModels.findIndex((x) => x.type === m.model);
      if (i >= 0) ormModels.splice(i, 1);
      DI.RootContainer.Registry.unregister(m.model);
      unregisterResource(m.model);
    }
  }

  async close(): Promise<void> {
    try {
      await this.clear();
      DI.RootContainer.uncache(Orm);
      await this.orm.dispose();
    } finally {
      this.restoreConfig();
      if (this.postgresDatabase !== undefined) await dropPostgresDatabase(this.postgresDatabase);
      if (this.mysqlDatabase !== undefined) await mysqlAdmin(`DROP DATABASE IF EXISTS ${this.mysqlDatabase}`);
    }
    if (this.ownsInstall) await testHost.uninstallHost();
  }
}
