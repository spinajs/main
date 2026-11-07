import { createTestApp, disposeTestApps, testManifest, withManifest } from '@spinajs/testing';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { ModelColumn, ModelEntry } from '@spinajs/manifest';
import { expect } from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import '@spinajs/log';
import { Connection, DatetimeValueConverter, extractModelDescriptor, Ignore, Model, ModelBase, Orm, ORM_DB_VALUE_CONVERTERS, Primary, SqlDialect, Uuid } from '../src/index.js';
import type { IColumnDescriptor } from '../src/index.js';
import { col, live } from './schema-diff/fixture.js';
import { FakeSqliteDriver, logText } from './misc.js';

const CONNECTION = 'manifest-source';

let source: 'database' | 'manifest' = 'manifest';

/** Live columns per table; a table not listed is missing. */
const TABLES = new Map<string, IColumnDescriptor[]>();

@SqlDialect({ name: 'test', grammar: 'Sqlite', placeholders: 'question', families: {}, count: 'number', sum: {}, avg: {}, predicates: 'number', nativeTypes: { integer: ['integer'] } })
class ManifestSourceDriver extends FakeSqliteDriver {
  public async tableInfo(table: string): Promise<IColumnDescriptor[]> {
    return TABLES.get(table) ?? (null as unknown as IColumnDescriptor[]);
  }
}

class ManifestSourceConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config = {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      db: { Models: { Source: source }, Connections: [{ Driver: 'manifest-source-driver', Name: CONNECTION, Migration: { OnStartup: false } }] },
    };
  }
}

const entry = (className: string, tableName: string, columns: ModelColumn[]): ModelEntry => ({ id: `app:${className}`, className, tableName, connection: CONNECTION, columns, relations: [], accessResource: false, source: { file: 'src/models.ts', line: 1, col: 1, package: 'app' } });

/** Declared here rather than at module scope: @Model registers globally, and after() unregisters them. */
function defineModels() {
  @Connection(CONNECTION)
  @Model('flagged')
  class Flagged extends ModelBase {
    @Primary()
    public Id: number;

    @Uuid()
    public Ref: string;

    @Ignore()
    public Note: string;
  }

  @Connection(CONNECTION)
  @Model('stamped')
  class Stamped extends ModelBase {
    @Primary()
    public Id: number;

    public At: unknown;

    public Flag: boolean;
  }

  /** Registered, but missing from the manifest: a stale manifest. */
  @Connection(CONNECTION)
  @Model('ghosts')
  class Ghost extends ModelBase {
    @Primary()
    public Id: number;
  }

  return { Flagged, Stamped, Ghost };
}

const MANIFEST = testManifest({
  models: [entry('Flagged', 'flagged', [col('Id', { family: 'integer', inferred: true }, { primary: true }), col('Ref', { family: 'text', inferred: true }), col('Note', { family: 'text', inferred: true })]),
    entry('Stamped', 'stamped', [col('Id', { family: 'integer', inferred: true }, { primary: true }), col('At', { family: 'datetime', inferred: true }), col('Flag', { family: 'boolean', inferred: true })]),
  ],
});

async function boot(): Promise<Orm> {
  await createTestApp({ configuration: ManifestSourceConf, register: (c) => {
    c.register(ManifestSourceDriver).as('manifest-source-driver');
    withManifest(MANIFEST, 'require')(c);
  } });
  return DI.resolve(Orm);
}

describe('db.Models.Source = manifest at boot', () => {
  let models: ReturnType<typeof defineModels>;

  before(() => {
    models = defineModels();
  });

  after(() => {
    Object.values(models).forEach((m) => DI.unregister(m));
  });

  beforeEach(() => {
    source = 'manifest';
    TABLES.clear();
    TABLES.set('flagged', [live('Id', 'INTEGER', { PrimaryKey: true }), live('Ref', 'TEXT'), live('Note', 'TEXT')]);
    TABLES.set('stamped', [live('Id', 'INTEGER', { PrimaryKey: true }), live('At', 'TEXT'), live('Flag', 'INTEGER')]);
    TABLES.set('ghosts', [live('Id', 'INTEGER', { PrimaryKey: true }), live('Legacy', 'TEXT')]);
  });

  afterEach(async () => {
    sinon.restore();
    await disposeTestApps();
  });

  const driftWarnings = (orm: Orm) => {
    const warn = sinon.spy((orm as unknown as { Log: { warn(...args: unknown[]): void } }).Log, 'warn');
    return () => warn.getCalls().map(logText).filter((t) => t.startsWith('Column drift'));
  };

  // first: the keys it registers stay in the process
  it("adds no datetime or date converter keys under 'database'", async () => {
    source = 'database';
    const orm = await boot();
    expect([...orm.Container.get(ORM_DB_VALUE_CONVERTERS)!.keys()].filter((k) => k === 'datetime' || k === 'date')).to.deep.equal([]);
  });

  it('converts by family, falls back to tableInfo() for a stale model, and reports a family mismatch without failing the boot', async () => {
    const orm = await boot();
    const columns = (model: typeof ModelBase) => extractModelDescriptor(model)!.Columns;
    expect(columns(models.Stamped).find((c) => c.Name === 'At')!.Converter).to.be.instanceOf(DatetimeValueConverter);
    expect(columns(models.Ghost).map((c) => `${c.Name}:${c.NativeType}`)).to.deep.equal(['Id:INTEGER', 'Legacy:TEXT']);
    expect(orm.ColumnDrift.map((d) => d.message)).to.deep.equal(['column stamped.Flag is INTEGER on connection manifest-source, model Stamped declares boolean']);
  });

  it('keeps the flags only decorators set: a manifest descriptor never clears @Uuid or @Ignore', async () => {
    await boot();
    const columns = extractModelDescriptor(models.Flagged)!.Columns;
    expect(columns.find((c) => c.Name === 'Ref')!.Uuid).to.equal(true);
    expect(columns.find((c) => c.Name === 'Note')!.Ignore).to.equal(true);
  });

  it('warns again only the drift of the models a non-strict reload read', async () => {
    const orm = await boot();
    const warned = driftWarnings(orm);
    await orm.reloadTableInfo({ models: [models.Flagged] });
    expect(warned()).to.deep.equal([]);
    await orm.reloadTableInfo({ models: [models.Stamped] });
    expect(warned()).to.deep.equal(['Column drift: "column stamped.Flag is INTEGER on connection manifest-source, model Stamped declares boolean"']);
  });
});
