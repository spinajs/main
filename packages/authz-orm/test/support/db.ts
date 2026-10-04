import '@spinajs/log';
import '@spinajs/orm-sqlite';
import '@spinajs/orm-postgres';

import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { testHost } from '@spinajs/authz-testing';

import { unregisterResource } from '../../src/registry.js';

export type Dialect = 'sqlite' | 'postgres';

export const POSTGRES = { Host: 'localhost', Port: Number(process.env.ORM_TEST_POSTGRES_PORT ?? 15432), User: 'postgres', Password: 'postgres', Database: 'test' };

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

  private constructor(readonly orm: Orm, readonly dialects: readonly Dialect[]) {}

  static async postgresReachable(): Promise<boolean> {
    const net = await import('node:net');
    return new Promise((resolve) => {
      const s = net.createConnection({ host: POSTGRES.Host, port: POSTGRES.Port });
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(1000, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
  }

  static async open(opts: { postgres?: boolean } = {}): Promise<TestDb> {
    let ownsInstall = false;
    try {
      testHost.config();
    } catch {
      await testHost.installHost();
      ownsInstall = true;
    }
    const cfg = testHost.config();
    const connections: unknown[] = [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' }];
    // The orm qualifies a joined Postgres table with the database name as its schema; a schema of
    // that name on the search path makes the joined and the unqualified spelling one table.
    if (opts.postgres) connections.push({ Driver: 'orm-driver-postgres', Name: 'postgres', ...POSTGRES, Options: { Schema: POSTGRES.Database } });
    const before = { logger: cfg.get<unknown>('logger'), db: cfg.get<unknown>('db') };
    cfg.set('logger', { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] });
    cfg.set('db', { DefaultConnection: 'sqlite', Connections: connections });

    const orm = await DI.resolve(Orm);
    const db = new TestDb(orm, opts.postgres ? ['sqlite', 'postgres'] : ['sqlite']);
    if (opts.postgres) await db.raw(`CREATE SCHEMA IF NOT EXISTS "${POSTGRES.Database}"`, [], 'postgres');
    db.ownsInstall = ownsInstall;
    db.restoreConfig = () => {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) cfg.unset(k);
        else cfg.set(k, v);
      }
    };
    return db;
  }

  driver(dialect: Dialect = 'sqlite'): OrmDriver {
    const d = this.orm.Connections.get(dialect);
    if (!d) throw new Error(`TestDb: no connection ${dialect}`);
    return d;
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

    const columns = { id: 'TEXT', ...spec.columns };
    const ddl = Object.entries(columns)
      .map(([c, t]) => `"${c}" ${t}${c === 'id' ? ' PRIMARY KEY' : ''}`)
      .join(', ');
    await this.raw(`CREATE TABLE "${table}" (${ddl})`, [], dialect);
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
    const marks = m.dialect === 'postgres' ? keys.map((_, i) => `$${i + 1}`) : keys.map(() => '?');
    await this.raw(`INSERT INTO "${m.table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${marks.join(', ')})`, params, m.dialect);
  }

  /** The raw table, unscoped. */
  async rows(model: typeof ModelBase): Promise<Record<string, unknown>[]> {
    const m = this.find(model);
    return (await this.raw(`SELECT * FROM "${m.table}"`, [], m.dialect)) as Record<string, unknown>[];
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
      await this.raw(`DROP TABLE IF EXISTS "${m.table}"`, [], m.dialect);
      const i = ormModels.findIndex((x) => x.type === m.model);
      if (i >= 0) ormModels.splice(i, 1);
      DI.RootContainer.Registry.unregister(m.model);
      unregisterResource(m.model);
    }
  }

  async close(): Promise<void> {
    await this.clear();
    DI.RootContainer.uncache(Orm);
    await this.orm.dispose();
    this.restoreConfig();
    if (this.ownsInstall) await testHost.uninstallHost();
  }
}
