import '@spinajs/log';
import { testHost } from '@spinajs/authz-testing';
import { DI, TypedArray } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
// The registry's test seam, from the build the package itself resolves to: one copy of authz-orm.
import { unregisterResource } from '../../../authz-orm/lib/mjs/registry.js';

import { PG_SERVER, createPgDatabase, dropPgDatabase, rawQuery, requirePostgres } from '../support/db.js';

export type Kind = 'sqlite' | 'postgres';

export const KINDS: readonly Kind[] = ['sqlite', 'postgres'];

export type ModelClass = typeof ModelBase & (new () => ModelBase);

export interface ModelSpec {
  /** Class name, made unique per definition; the table is its lower case. */
  readonly name: string;
  /** Column → SQL type, `id` included; `id` is the primary key. */
  readonly columns: Readonly<Record<string, string>>;
  readonly rows?: readonly Readonly<Record<string, unknown>>[];
  /** authz-orm decorators and the like, applied before the orm sees the class. */
  readonly decorate?: (model: ModelClass, proto: object) => void;
  /** Extends this model class instead of ModelBase. */
  readonly base?: ModelClass;
  /** Reads this existing table (no CREATE TABLE; `columns` are ignored). */
  readonly table?: string;
}

let seq = 0;

/**
 * The drivers register themselves under their names, but a suite that unregisters a driver class
 * leaves the name with no type. Registers `driver` under `name` only then; the undo restores that.
 */
function ensureDriver(name: string, driver: Class<unknown>): () => void {
  if ((DI.RootContainer.Registry.getTypes(name, false) ?? []).length > 0) return () => undefined;
  DI.register(driver).as(name);
  return () => {
    const list = DI.RootContainer.Registry.getTypes(name, false) ?? [];
    const i = list.indexOf(driver);
    if (i >= 0) list.splice(i, 1);
  };
}

/**
 * An Orm in the DI root, as authz-orm's adapter and middleware read it, over an in-memory SQLite
 * connection and a Postgres database of its own (L2_REQUIRE_PG=1: unreachable is a failure). The
 * test host's configuration carries it; `close()` drops the models (authz-orm registry included).
 */
export class RootOrm {
  private readonly models: { model: ModelClass; table: string; kind: Kind }[] = [];

  private constructor(readonly orm: Orm, private readonly database: string, private readonly undo: () => Promise<void>) {}

  static connectionOf(kind: Kind): string {
    return kind === 'sqlite' ? 'l4b-orm-sqlite' : 'l4b-orm-pg';
  }

  static async open(ctx: Mocha.Context, suite: string): Promise<RootOrm> {
    await requirePostgres(ctx);
    let ownsInstall = false;
    try {
      testHost.config();
    } catch {
      await testHost.installHost();
      ownsInstall = true;
    }
    const cfg = testHost.config();
    const before = { logger: cfg.get<unknown>('logger'), db: cfg.get<unknown>('db') };
    const database = await createPgDatabase(suite);
    cfg.set('logger', { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] });
    cfg.set('db', {
      DefaultConnection: RootOrm.connectionOf('sqlite'),
      Connections: [
        { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: RootOrm.connectionOf('sqlite') },
        { Driver: 'orm-driver-postgres', Name: RootOrm.connectionOf('postgres'), ...PG_SERVER, Database: database },
      ],
    });
    DI.setESMModuleSupport();
    const drivers = [ensureDriver('orm-driver-sqlite', SqliteOrmDriver), ensureDriver('orm-driver-postgres', PostgresOrmDriver)];
    // After check-config and the integration suites another copy of @spinajs/di has replaced the global
    // Array.ofType with one making its own TypedArray, which this copy's container does not take for a
    // list: Array.ofType lists (authz-orm's native compilers, the orm's hydrators) would resolve empty.
    const ofType = Array.ofType;
    Array.ofType = <T>(type: Class<T> | string) => new TypedArray<T>(type);
    const restore = async () => {
      for (const undo of drivers) undo();
      Array.ofType = ofType;
      await dropPgDatabase(database);
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) cfg.unset(k);
        else cfg.set(k, v);
      }
      if (ownsInstall) await testHost.uninstallHost();
    };
    let orm: Orm;
    try {
      orm = (await DI.resolve(Orm)) as Orm;
    } catch (e) {
      DI.RootContainer.uncache(Orm);
      await restore();
      throw e;
    }
    return new RootOrm(orm, database, async () => {
      DI.RootContainer.uncache(Orm);
      try {
        await orm.dispose();
      } finally {
        await restore();
      }
    });
  }

  driver(kind: Kind): OrmDriver {
    const d = this.orm.Connections.get(RootOrm.connectionOf(kind));
    if (!d) throw new Error(`RootOrm: no ${kind} connection`);
    return d;
  }

  raw(kind: Kind, sql: string, bindings: unknown[] = []): Promise<any> {
    return rawQuery(this.driver(kind), sql, bindings);
  }

  /** Defines a model on `kind`'s connection, creates its table and inserts the rows unscoped. */
  async define(spec: ModelSpec, kind: Kind): Promise<ModelClass> {
    const name = `${spec.name}_${process.pid}_${++seq}`;
    const table = spec.table ?? name.toLowerCase();
    const Base = spec.base ?? ModelBase;
    const cls = { [name]: class extends Base {} }[name] as ModelClass;
    Primary()(cls.prototype, 'id');
    spec.decorate?.(cls, cls.prototype);
    Connection(RootOrm.connectionOf(kind))(cls);
    Model(table)(cls);

    const ddl = Object.entries(spec.columns)
      .map(([c, t]) => `"${c}" ${t}${c === 'id' ? ' PRIMARY KEY' : ''}`)
      .join(', ');
    if (spec.table === undefined) await this.raw(kind, `CREATE TABLE "${table}" (${ddl})`);
    this.models.push({ model: cls, table, kind });

    const orm = this.orm as unknown as { registerModel(m: unknown): void; applyModelMixins(): void; wireRelations(): void };
    orm.registerModel(cls);
    orm.wireRelations();
    orm.applyModelMixins();
    await this.orm.reloadTableInfo();
    await this.insert(cls, spec.rows ?? []);
    return cls;
  }

  /** Unscoped inserts, past every query middleware. */
  async insert(model: ModelClass, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
    const m = this.find(model);
    for (const row of rows) {
      const keys = Object.keys(row);
      const marks = m.kind === 'postgres' ? keys.map((_, i) => `$${i + 1}`) : keys.map(() => '?');
      await this.raw(
        m.kind,
        `INSERT INTO "${m.table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${marks.join(', ')})`,
        keys.map((k) => row[k]),
      );
    }
  }

  async clearRows(model: ModelClass): Promise<void> {
    const m = this.find(model);
    await this.raw(m.kind, `DELETE FROM "${m.table}"`);
  }

  table(model: ModelClass): string {
    return this.find(model).table;
  }

  private find(model: ModelClass) {
    const m = this.models.find((x) => x.model === model);
    if (!m) throw new Error(`RootOrm: ${model.name} was not defined here`);
    return m;
  }

  /** Drops the tables and forgets the classes: the orm's model list, DI, authz-orm's registry. */
  async clear(): Promise<void> {
    const ormModels = this.orm.Models as { type: unknown }[];
    for (const m of this.models.splice(0).reverse()) {
      await this.raw(m.kind, `DROP TABLE IF EXISTS "${m.table}"`);
      const i = ormModels.findIndex((x) => x.type === m.model);
      if (i >= 0) ormModels.splice(i, 1);
      DI.RootContainer.Registry.unregister(m.model);
      unregisterResource(m.model);
    }
  }

  async close(): Promise<void> {
    try {
      await this.clear();
    } finally {
      await this.undo();
    }
  }

  get pgDatabase(): string {
    return this.database;
  }
}
