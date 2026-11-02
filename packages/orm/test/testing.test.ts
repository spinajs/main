import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, IContainer, NewInstance } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ESLint } from 'eslint';
import 'mocha';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import '@spinajs/log';
import { Connection, extractModelDescriptor, IColumnDescriptor, IMigrationRecord, InsertQueryBuilder, MIGRATION_TABLE_NAME, Migration, MigrationTransactionMode, Model, ModelBase, Orm, OrmDriver, OrmMigration, Primary, SelectQueryBuilder, TableExistsQueryBuilder, TableQueryBuilder, UpdateQueryBuilder } from '../src/index.js';
import { migrateTestDatabase } from '../src/testing/index.js';
import { FakeSqliteDriver } from './misc.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const CONNECTION = 'testing-helper';

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
  const code = ["import { migrateTestDatabase } from '@spinajs/orm/testing';", '', 'export const helper = migrateTestDatabase;', ''].join('\n');

  async function bans(file: string): Promise<string[]> {
    const [result] = await new ESLint({ cwd: root }).lintText(code, { filePath: path.join(root, file) });
    return result.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
  }

  it('fails an import of the helper from framework code', async () => {
    expect(await bans('packages/orm-cli/src/orm.ts')).to.deep.equal(["'@spinajs/orm/testing' import is restricted from being used. Test helper: applications migrate with `npx spinajs migrate-up`."]);
  });

  it('allows it in a test file', async () => {
    expect(await bans('packages/orm-cli/test/cli.test.ts')).to.deep.equal([]);
  });
});
