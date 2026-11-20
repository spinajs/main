import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, IContainer, NewInstance } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ESLint } from 'eslint';
import 'mocha';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import '@spinajs/log';
import { Connection, extractModelDescriptor, IColumnDescriptor, IMigrationRecord, InsertQueryBuilder, MIGRATION_TABLE_NAME, Migration, MigrationTransactionMode, Model, ModelBase, Orm, OrmDriver, OrmException, OrmMigration, OrmMigrationGuard, OrmMigrator, Primary, SelectQueryBuilder, TableExistsQueryBuilder, TableQueryBuilder, UpdateQueryBuilder } from '../src/index.js';
import { migrateTestDatabase } from '../src/testing/index.js';
import { FakeSqliteDriver } from './misc.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const CONNECTION = 'testing-helper';

const CALL_ORDER =
  'migrateTestDatabase() must run before anything resolves the Orm or OrmMigrationGuard in this container ( or after Orm, OrmMigrator and OrmMigrationGuard were uncached together, or DI.clearCache() ): the boot guard here is enabled, so the Orm was booted as an application boots it';

const TABLES = new Map<string, string[]>();
let RECORDS: IMigrationRecord[] = [];
let seeded: string[] = [];

function columnDescriptor(name: string): IColumnDescriptor {
  return {
    Type: 'INT',
    MaxLength: 0,
    Comment: '',
    DefaultValue: null,
    NativeType: 'INT',
    Unsigned: false,
    Nullable: true,
    PrimaryKey: name === 'Id',
    AutoIncrement: false,
    Name: name,
    Converter: null,
    Schema: CONNECTION,
    Unique: false,
    Uuid: false,
    Ignore: false,
    IsForeignKey: false,
    ForeignKeyDescription: null,
    Aggregate: false,
    Virtual: false,
  };
}

/** A database of table names and columns, with a tracking table that remembers what was applied. */
@NewInstance()
class TestingHelperDriver extends FakeSqliteDriver {
  public async execute(b: any): Promise<any> {
    if (b instanceof SelectQueryBuilder) {
      return b.Table === MIGRATION_TABLE_NAME ? RECORDS.map((r) => ({ ...r })) : [];
    }

    if (b instanceof TableExistsQueryBuilder) {
      return TABLES.has(b.Table) ? [{ 1: 1 }] : [];
    }

    if (b instanceof TableQueryBuilder) {
      TABLES.set(
        b.Table,
        b.Columns.map((c) => c.Name),
      );
    } else if (b instanceof InsertQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
      RECORDS.push({ Migration: b.getColumnValues('Migration')[0] as string, CreatedAt: new Date(), StartedAt: new Date(), FinishedAt: null, RolledBackAt: null, Logs: null, Checksum: null, Batch: 0 });
    } else if (b instanceof UpdateQueryBuilder && b.Table === MIGRATION_TABLE_NAME && (b.Value as Partial<IMigrationRecord>).FinishedAt) {
      Object.assign(RECORDS.find((r) => !r.FinishedAt) ?? {}, b.Value);
    }

    return [{ 1: 1 }];
  }

  public async tableInfo(table: string): Promise<IColumnDescriptor[]> {
    // a missing table answers null like a real driver, which the abstract signature does not declare
    return TABLES.has(table) ? TABLES.get(table)!.map(columnDescriptor) : (null as unknown as IColumnDescriptor[]);
  }
}

class TestingHelperConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      db: {
        StrictTableCheck: true,
        Connections: [{ Driver: 'testing-helper-driver', Name: CONNECTION, Migration: { Transaction: { Mode: MigrationTransactionMode.None } } }],
      },
    };
  }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }

  return undefined;
}

function restoreEnv(key: 'NODE_ENV' | 'APP_ENV', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function defineSchema() {
  @Connection(CONNECTION)
  @Model('testing_helper_items')
  class TestModel extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Migration(CONNECTION)
  class A_2026_01_01_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver) {
      await connection.schema().createTable('testing_helper_items', (t) => {
        t.int('Id').primaryKey();
      });
    }

    public async down() {}

    public async data() {
      seeded.push(this.constructor.name);
    }
  }

  return { TestModel, A_2026_01_01_00_00_00 };
}

describe('@spinajs/orm/testing migrateTestDatabase()', function () {
  this.timeout(10000);

  const { NODE_ENV, APP_ENV } = process.env;
  let types: ReturnType<typeof defineSchema>;
  let container: IContainer;

  beforeEach(() => {
    DI.clearCache();
    DI.register(TestingHelperConf).as(Configuration);
    DI.register(TestingHelperDriver).as('testing-helper-driver');

    // present up front: the tracking tables' DDL needs column builders this fake does not answer for
    TABLES.clear();
    TABLES.set(MIGRATION_TABLE_NAME, ['Migration', 'CreatedAt', 'StartedAt', 'FinishedAt', 'RolledBackAt', 'Logs', 'Checksum', 'Batch']);
    TABLES.set(`${MIGRATION_TABLE_NAME}_lock`, ['Id', 'AcquiredAt', 'Owner']);
    RECORDS = [];
    seeded = [];
    types = defineSchema();
    container = DI.child();
  });

  afterEach(() => {
    restoreEnv('NODE_ENV', NODE_ENV);
    restoreEnv('APP_ENV', APP_ENV);

    Object.values(types).forEach((t) => DI.unregister(t));
    DI.unregister(TestingHelperConf);
    DI.unregister(TestingHelperDriver);
    DI.clearCache();
  });

  it('migrateTestDatabase() migrates, seeds and leaves a resolved Orm with column info', async () => {
    const { orm, executed } = await migrateTestDatabase(container);
    expect(executed.map((m) => m.constructor.name)).to.deep.equal(['A_2026_01_01_00_00_00']);
    expect(extractModelDescriptor(types.TestModel)!.Columns.map((c) => c.Name)).to.include('Id');
    expect(seeded).to.deep.equal(['A_2026_01_01_00_00_00']);
    expect(container.get(Orm)).to.equal(orm);
  });

  it('migrateTestDatabase({ seed: false }) migrates without running data()', async () => {
    const { executed } = await migrateTestDatabase(container, { seed: false });

    expect(executed).to.have.length(1);
    expect(seeded).to.deep.equal([]);
  });

  it('migrateTestDatabase() fails like a strict boot when a model still has no table', async () => {
    @Connection(CONNECTION)
    @Model('testing_helper_missing')
    class TestMissingModel extends ModelBase {
      @Primary()
      public Id: number;
    }

    try {
      await expect(migrateTestDatabase(container)).to.be.rejectedWith('Missing tables (db.StrictTableCheck): model TestMissingModel: table testing_helper_missing');
    } finally {
      DI.unregister(TestMissingModel);
    }
  });

  it('migrateTestDatabase() refuses an Orm resolved before it, naming the call-order rule', async () => {
    // a database migrated earlier, so the application's boot check passes
    TABLES.set('testing_helper_items', ['Id']);
    RECORDS.push({ Migration: 'A_2026_01_01_00_00_00', CreatedAt: new Date(), StartedAt: new Date(), FinishedAt: new Date(), RolledBackAt: null, Logs: null, Checksum: null, Batch: 1 });
    await container.resolve(Orm);

    const err = await rejection(migrateTestDatabase(container));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.equal(CALL_ORDER);
  });

  it('migrateTestDatabase() refuses an OrmMigrationGuard resolved before it with its default options', async () => {
    await container.resolve(OrmMigrationGuard);

    const err = await rejection(migrateTestDatabase(container));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.equal(CALL_ORDER);
    expect(TABLES.has('testing_helper_items'), 'it refuses before it migrates').to.be.false;
  });

  it('migrateTestDatabase() refuses a re-run after only the Orm was uncached', async () => {
    await migrateTestDatabase(container);
    container.uncache(Orm);

    await expect(migrateTestDatabase(container)).to.be.rejectedWith(OrmException, 'The cached OrmMigrator runs over an Orm that is no longer cached');
  });

  it('migrateTestDatabase() runs again after only OrmMigrator was uncached, over the cached Orm', async () => {
    const first = await migrateTestDatabase(container);
    container.uncache(OrmMigrator);

    const second = await migrateTestDatabase(container);

    expect(second.orm).to.equal(first.orm);
    expect(second.migrator).to.not.equal(first.migrator);
    expect(second.executed).to.deep.equal([]);
  });

  it('migrateTestDatabase() runs again once Orm and OrmMigrator were uncached together', async () => {
    const first = await migrateTestDatabase(container);
    container.uncache(Orm);
    container.uncache(OrmMigrator);

    const second = await migrateTestDatabase(container);

    expect(second.orm).to.not.equal(first.orm);
    expect(second.migrator.Orm).to.equal(second.orm);
    expect(second.executed).to.deep.equal([]);
  });

  it('migrateTestDatabase() refuses when APP_ENV or NODE_ENV is explicitly production', async () => {
    process.env.NODE_ENV = 'production';
    await expect(migrateTestDatabase(container)).to.be.rejectedWith(/test helper/);

    delete process.env.NODE_ENV;
    process.env.APP_ENV = 'prod';
    await expect(migrateTestDatabase(container)).to.be.rejectedWith(/test helper/);

    expect(TABLES.has('testing_helper_items'), 'it refuses before it touches the database').to.be.false;
    expect(RECORDS).to.deep.equal([]);
  });
});

describe('the @spinajs/orm/testing lint ban', function () {
  this.timeout(120000);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const MESSAGE = 'Test helper: applications migrate with `npx spinajs migrate-up`.';
  const eslint = new ESLint({ cwd: root });

  async function bans(file: string, ...lines: string[]): Promise<string[]> {
    const [result] = await eslint.lintText([...lines, ''].join('\n'), { filePath: path.join(root, file) });
    return result.messages.filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax').map((m) => m.message);
  }

  const staticImport = ["import { migrateTestDatabase } from '@spinajs/orm/testing';", 'export const helper = migrateTestDatabase;'];

  it('fails an import of the helper from framework code', async () => {
    expect(await bans('packages/orm-cli/src/orm.ts', ...staticImport)).to.deep.equal([`'@spinajs/orm/testing' import is restricted from being used. ${MESSAGE}`]);
  });

  it('fails a re-export and the deep lib path', async () => {
    expect(await bans('packages/orm-cli/src/orm.ts', "export * from '@spinajs/orm/testing';")).to.deep.equal([`'@spinajs/orm/testing' import is restricted from being used. ${MESSAGE}`]);
    expect(await bans('packages/orm-cli/src/orm.ts', "export { migrateTestDatabase } from '@spinajs/orm/lib/mjs/testing/index.js';")).to.deep.equal([
      `'@spinajs/orm/lib/mjs/testing/index.js' import is restricted from being used by a pattern. ${MESSAGE}`,
    ]);
  });

  it('fails a dynamic import, a createRequire() require and a relative path to the orm sources', async () => {
    expect(await bans('packages/orm-cli/src/orm.ts', "export const helper = () => import('@spinajs/orm/testing');")).to.deep.equal([MESSAGE]);
    expect(await bans('packages/orm-cli/src/orm.ts', "import { createRequire } from 'node:module';", "export const helper = createRequire(import.meta.url)('@spinajs/orm/lib/cjs/testing/index.js');")).to.deep.equal([MESSAGE]);
    expect(await bans('packages/orm-cli/src/orm.ts', "export const helper = () => import('../../orm/src/testing/index.js');")).to.deep.equal([MESSAGE]);
  });

  it('fails a relative import of the helper inside the orm sources, but not inside the helper itself', async () => {
    expect(await bans('packages/orm/src/orm.ts', "export { migrateTestDatabase } from './testing/index.js';")).to.deep.equal([`'./testing/index.js' import is restricted from being used by a pattern. ${MESSAGE}`]);
    expect(await bans('packages/orm/src/orm.ts', "export const helper = () => import('./testing/index.js');")).to.deep.equal([MESSAGE]);
    expect(await bans('packages/orm/src/testing/index.ts', "import { OrmMigrator } from '../migrator.js';", 'export const migrator = OrmMigrator;')).to.deep.equal([]);
  });

  it('allows it in a test file', async () => {
    expect(await bans('packages/orm-cli/test/cli.test.ts', ...staticImport)).to.deep.equal([]);
    expect(await bans('packages/orm-cli/test/cli.test.ts', "export const helper = () => import('@spinajs/orm/testing');")).to.deep.equal([]);
  });

  it('leaves other packages alone', async () => {
    expect(await bans('packages/orm-cli/src/orm.ts', "export { Orm } from '@spinajs/orm';", "export const helper = () => import('@spinajs/authn-testing');")).to.deep.equal([]);
  });
});
