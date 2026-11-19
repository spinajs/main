import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, extractModelDescriptor, Migration, Model, ModelBase, Orm, OrmDriver, OrmMigration, OrmMigrationGuard, Primary } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import '@spinajs/log';

import { SqliteOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';

const CONNECTION = 'sqlite-test-helper';

class TestHelperSqliteConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: {
          StrictTableCheck: true,
          Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: CONNECTION }],
        },
      },
      mergeArrays,
    );
  }
}

function defineSchema() {
  @Connection(CONNECTION)
  @Model('test_helper_items')
  class TestHelperItem extends ModelBase {
    @Primary()
    public Id: number;

    public Label: string;
  }

  @Migration(CONNECTION)
  class TestHelperItems_2026_10_01_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().createTable('test_helper_items', (table) => {
        table.int('Id').primaryKey();
        table.string('Label');
      });
    }

    public async down(): Promise<void> {}

    // resolves a model query through the Orm, as a seed in a real package does
    public async data(): Promise<void> {
      if (!(await TestHelperItem.where({ Id: 1 }).first())) {
        await TestHelperItem.insert(new TestHelperItem({ Id: 1, Label: 'seeded' }));
      }
    }
  }

  return { TestHelperItem, TestHelperItems_2026_10_01_00_00_00 };
}

describe('migrateTestDatabase() on sqlite', function () {
  this.timeout(20000);

  let types: ReturnType<typeof defineSchema>;

  before(() => {
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(() => {
    DI.clearCache();
    DI.register(TestHelperSqliteConf).as(Configuration);
    types = defineSchema();
  });

  afterEach(async () => {
    await DI.get(Orm)?.dispose();
    Object.values(types).forEach((t) => DI.unregister(t));
    DI.unregister(TestHelperSqliteConf);
    DI.clearCache();
  });

  it('migrates and seeds the database, reads its columns and leaves nothing for the boot guard to refuse', async () => {
    const { orm, executed } = await migrateTestDatabase();

    expect(executed.map((m) => m.constructor.name)).to.deep.equal(['TestHelperItems_2026_10_01_00_00_00']);
    expect(extractModelDescriptor(types.TestHelperItem)!.Columns.map((c) => c.Name)).to.include.members(['Id', 'Label']);
    expect((await types.TestHelperItem.all()).map((i) => i.Label)).to.deep.equal(['seeded']);
    expect(await (await DI.resolve(OrmMigrationGuard)).check(orm)).to.deep.equal({ pending: [], failed: [], warned: [] });
  });
});
