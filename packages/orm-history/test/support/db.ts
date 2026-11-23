import './audit.js';
import '@spinajs/orm-sqlite';
import { rowsOf } from '@spinajs/audit-orm';
import type { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { MemoryTarget } from '@spinajs/log';
import { Connection, Model, ModelBase, Orm, Primary, RawQuery } from '@spinajs/orm';
import type { OrmDriver, TableQueryBuilder } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { createTestDatabase } from '@spinajs/testing-orm';
import type { TestDatabase } from '@spinajs/testing-orm';

import { OrmHistory_2026_11_16_00_00_00 } from '../../src/index.js';
import type { TrackedModel, TrackedRow } from '../../src/index.js';
import { resetAudit } from './audit.js';

export type Dialect = 'sqlite' | 'pglite';
/** A dialect's connection, or `spare`: another sqlite `:memory:` connection, neither dialect's. */
export type Place = Dialect | 'spare';
export type ColumnType = 'TEXT' | 'INTEGER' | 'BIGINT' | 'JSON' | 'DATETIME';

/**
 * A model class `define` made: a class defined at run time has no declaration to carry the two history members, nor
 * its columns, so its rows take any column (`update()` takes a `Partial` of the row).
 */
export type TrackedClass = typeof ModelBase & TrackedModel & (new () => ModelBase & TrackedRow & Record<string, unknown>);

export interface ModelSpec {
  /** Class name. */
  readonly name: string;
  /** Also the subject type of its history events. */
  readonly table: string;
  /** Column → type; `id` is the primary key, TEXT unless `autoIncrement`. */
  readonly columns: Readonly<Record<string, ColumnType>>;
  /** Applied to the class and its prototype before the ORM sees it: `registerHistory`, `@Hidden`, `@SoftDelete`, `@Archived`. */
  readonly decorate: (model: typeof ModelBase, proto: object) => void;
  readonly autoIncrement?: boolean;
  /** A TEXT `id` that sqlite fills when an insert leaves it out. */
  readonly filledKey?: boolean;
  /** The model's `@Primary()` columns instead of `id`, all listed in `columns`; the table then has no primary key. */
  readonly primary?: readonly string[];
  /** Extends this class and maps onto its table, which then is not created again; `columns` and `autoIncrement` are ignored. */
  readonly base?: TrackedClass;
  /** Extends this abstract class, which declares the `@Primary()` `id`; the table is created as without `base`. */
  readonly abstractBase?: abstract new () => ModelBase;
  /** Maps onto a table an earlier `define` created, without extending its class; `columns` and `autoIncrement` are ignored. */
  readonly existingTable?: boolean;
  /** The connection name the class declares instead of the dialect's; it must name the dialect's driver (`HistoryDb.aliasOf`, `default`). */
  readonly connection?: string;
}

interface Defined {
  readonly model: TrackedClass;
  readonly table: string;
  readonly dialect: Place;
  readonly ownsTable: boolean;
}

// What the tests call on Orm; registerModel and wireRelations are protected and applyModelMixins private. The
// follow-up "a public defineTestModel in @spinajs/orm/testing" removes this cast here and in authz-orm's test db.
interface ModelRegistration {
  registerModel(model: TrackedClass): void;
  wireRelations(): void;
  applyModelMixins(): void;
}

/** Applies a decorator of `@spinajs/orm` by hand: its factories return `any`, which no-unsafe-call refuses to call. */
export function applyDecorator(decorator: unknown, target: object, property?: string): void {
  if (typeof decorator !== 'function') throw new TypeError('applyDecorator: not a decorator');
  Reflect.apply(decorator, undefined, property === undefined ? [target] : [target, property]);
}

const DIALECTS: readonly Dialect[] = ['sqlite', 'pglite'];
const COLUMN = new Map<ColumnType, (t: TableQueryBuilder, name: string) => void>([
  ['TEXT', (t, name) => t.text(name)],
  ['INTEGER', (t, name) => t.int(name)],
  ['BIGINT', (t, name) => t.bigint(name)],
  ['JSON', (t, name) => t.json(name)],
  ['DATETIME', (t, name) => t.dateTime(name)],
]);
const LOGGER = {
  targets: [
    { name: 'Empty', type: 'BlackHoleTarget' },
    { name: 'Memory', type: 'MemoryTarget' },
  ],
  rules: [
    { name: '*', level: 'trace', target: 'Empty' },
    { name: 'orm-history', level: 'warn', target: 'Memory' },
  ],
};
const trailOn = (dialect: Dialect): string => `history-${dialect}`;
const AUDIT = {
  trails: {
    recorded: { store: 'MemoryAuditStore' },
    logged: { store: 'LogAuditStore' },
    ...Object.fromEntries(DIALECTS.map((d) => [trailOn(d), { table: `history_${d}`, connection: d }])),
  },
};

/** One ORM over sqlite `:memory:` (the default connection, migrated when opened), PGlite and the spare sqlite, with tracked models defined per test. */
export class HistoryDb {
  private readonly historyOn = new Set<Dialect>();
  private readonly models: Defined[] = [];

  private constructor(private readonly app: TestApp, private readonly orm: Orm, private readonly pglite: TestDatabase) {}

  static async open(): Promise<HistoryDb> {
    const pglite = await createTestDatabase({ connection: 'pglite', migrate: false });
    const connections: unknown[] = [{ Driver: 'orm-driver-sqlite', Name: 'sqlite', Filename: ':memory:' }, pglite.config, { Driver: 'orm-driver-sqlite', Name: 'spare', Filename: ':memory:' }];
    const aliases = Object.fromEntries(DIALECTS.map((d) => [HistoryDb.aliasOf(d), d]));
    let app: TestApp | undefined;
    try {
      app = await createTestApp({ config: { logger: LOGGER, db: { DefaultConnection: 'sqlite', StrictTableCheck: false, Connections: connections, Aliases: aliases }, audit: AUDIT } });
      // v4 refuses Migration.OnStartup; the migrations registered on `default` (this package's among them) apply here.
      const { orm } = await migrateTestDatabase(app.container);
      return new HistoryDb(app, orm, pglite);
    } catch (err) {
      // A failing dispose must not replace the error that made open() fail.
      await app?.dispose().catch(() => undefined);
      await pglite.dispose().catch(() => undefined);
      throw err;
    }
  }

  static dialects(): readonly Dialect[] {
    return DIALECTS;
  }

  /** A table trail whose own connection is the one of `dialect`; its table, `history_<dialect>`, is not created. */
  static trailOn(dialect: Dialect): string {
    return trailOn(dialect);
  }

  /** A connection alias configured for the connection of `dialect`. */
  static aliasOf(dialect: Dialect): string {
    return `${dialect}-alias`;
  }

  get config(): Configuration {
    return this.app.config;
  }

  /** The messages the `orm-history` logger wrote at warn level or above since the last `clear()`. */
  warnings(): string[] {
    return (DI.get(MemoryTarget)?.getRecords() ?? []).filter((e) => e.Variables.logger === 'orm-history').map((e) => e.Variables.message);
  }

  driver(dialect: Place): OrmDriver {
    const driver = this.orm.Connections.get(dialect);
    if (!driver) throw new Error(`HistoryDb: no connection ${dialect}`);
    return driver;
  }

  /** The ORM connection name of a dialect: what a trail's `connection` and `AuditQuery.source` take. */
  connectionName(dialect: Dialect): string {
    return this.driver(dialect).Options.Name;
  }

  async close(): Promise<void> {
    await this.app.dispose();
    await this.pglite.dispose();
  }

  /** Creates an empty `orm_history` on `dialect`, dropping what an earlier test or `open()` left. */
  async migrateHistory(dialect: Dialect): Promise<void> {
    const table = new OrmHistory_2026_11_16_00_00_00();
    await table.down(this.driver(dialect));
    await table.up(this.driver(dialect));
    this.historyOn.add(dialect);
  }

  async dropHistory(dialect: Dialect): Promise<void> {
    await new OrmHistory_2026_11_16_00_00_00().down(this.driver(dialect));
    this.historyOn.delete(dialect);
  }

  /** Every row of `table`: a trail table by `seq`, a table of `define` by `id`. */
  async rows(table: string, dialect: Dialect): Promise<Record<string, unknown>[]> {
    return rowsOf(await this.driver(dialect).select().from(table).orderBy(table === 'orm_history' ? 'seq' : 'id')).map((row) => ({ ...row }));
  }

  /** Creates the table of `spec` on `dialect` and a model class over it on that connection. */
  async define(spec: ModelSpec, dialect: Place): Promise<TrackedClass> {
    const Base: abstract new () => ModelBase = spec.base ?? spec.abstractBase ?? ModelBase;
    const model = { [spec.name]: class extends Base {} }[spec.name] as TrackedClass;
    if (!spec.base && !spec.abstractBase) for (const column of spec.primary ?? ['id']) applyDecorator(Primary(), model.prototype, column);
    spec.decorate(model, model.prototype);
    applyDecorator(Connection(spec.connection ?? dialect), model);
    applyDecorator(Model(spec.table), model);

    const ownsTable = !spec.base && !spec.existingTable;
    if (ownsTable) {
      await this.driver(dialect)
        .schema()
        .createTable(spec.table, (t) => {
          if (spec.primary === undefined && spec.autoIncrement) t.int('id').primaryKey().autoIncrement();
          else if (spec.primary === undefined && spec.filledKey) t.text('id').primaryKey().default().raw(RawQuery.create('lower(hex(randomblob(8)))'));
          else if (spec.primary === undefined) t.text('id').primaryKey();
          for (const [column, type] of Object.entries(spec.columns)) COLUMN.get(type)?.(t, column);
        });
    }
    this.models.push({ model, table: spec.table, dialect, ownsTable });

    const orm = this.orm as unknown as ModelRegistration;
    orm.registerModel(model);
    orm.wireRelations();
    orm.applyModelMixins();
    await this.orm.reloadTableInfo();
    return model;
  }

  /** Drops what `define` created and forgets its classes; leaves an empty `orm_history` on sqlite only and no recorded audit state. */
  async clear(): Promise<void> {
    for (const m of this.models.splice(0).reverse()) {
      if (m.ownsTable) await this.driver(m.dialect).schema().dropTable(m.table).ifExists();
      const i = this.orm.Models.findIndex((x) => x.type === m.model);
      if (i >= 0) this.orm.Models.splice(i, 1);
      DI.RootContainer.Registry.unregister(m.model);
    }
    for (const dialect of this.historyOn) if (dialect !== 'sqlite') await this.dropHistory(dialect);
    await this.migrateHistory('sqlite');
    resetAudit();
    DI.get(MemoryTarget)?.clear();
  }
}
