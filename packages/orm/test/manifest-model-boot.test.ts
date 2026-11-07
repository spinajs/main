import { createTestApp, disposeTestApps, testManifest, withManifest } from '@spinajs/testing';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { ModelColumn, ModelEntry } from '@spinajs/manifest';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { Connection, extractModelDescriptor, Ignore, Model, ModelBase, Orm, Primary, Uuid } from '../src/index.js';
import type { IColumnDescriptor } from '../src/index.js';
import { col, live } from './schema-diff/fixture.js';
import { FakeSqliteDriver } from './misc.js';

const CONNECTION = 'manifest-source';

let source: 'database' | 'manifest' = 'manifest';

/** Live columns per table; a table not listed is missing. */
const TABLES = new Map<string, IColumnDescriptor[]>();

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

  return { Flagged };
}

const MANIFEST = testManifest({
  models: [entry('Flagged', 'flagged', [col('Id', { family: 'integer', inferred: true }, { primary: true }), col('Ref', { family: 'text', inferred: true }), col('Note', { family: 'text', inferred: true })])],
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
  });

  afterEach(async () => {
    await disposeTestApps();
  });

  it('keeps the flags only decorators set: a manifest descriptor never clears @Uuid or @Ignore', async () => {
    await boot();
    const columns = extractModelDescriptor(models.Flagged)!.Columns;
    expect(columns.find((c) => c.Name === 'Ref')!.Uuid).to.equal(true);
    expect(columns.find((c) => c.Name === 'Note')!.Ignore).to.equal(true);
  });
});
