import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Class, DI } from '@spinajs/di';
import { AlterTableQueryBuilder, Connection, extractModelDescriptor, Migration, Model, ModelBase, OrmDriver, OrmMigration, OrmMigrator, Primary } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import * as sinon from 'sinon';
import '@spinajs/log';

import { SqliteOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';

const CONNECTION = 'sqlite-mti';

class MigratorTableInfoConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: {
          StrictTableCheck: false,
          Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: CONNECTION, Migration: { Table: 'orm_migrations_mti', OnStartup: true } }],
        },
      },
      mergeArrays,
    );
  }
}

function defineSchema() {
  @Migration(CONNECTION)
  class MigratorTableInfoCreate_2026_10_22_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().createTable('mti_posts', (table) => {
        table.int('Id').primaryKey();
        table.string('Title');
        table.boolean('Flag');
      });

      await connection.schema().createTable('mti_notes', (table) => {
        table.int('Id').primaryKey();
        table.string('Body');
      });
    }

    public async down(): Promise<void> {}
  }

  @Connection(CONNECTION)
  @Model('mti_posts')
  class MigratorTableInfoPost extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Connection(CONNECTION)
  @Model('mti_notes')
  class MigratorTableInfoNote extends ModelBase {
    @Primary()
    public Id: number;
  }

  return { create: MigratorTableInfoCreate_2026_10_22_00_00_00, Post: MigratorTableInfoPost, Note: MigratorTableInfoNote };
}

/** The migration the second pass applies. */
function laterMigration(up: (connection: OrmDriver) => Promise<unknown>): Class<OrmMigration> {
  @Migration(CONNECTION)
  class MigratorTableInfoLater_2026_10_22_00_01_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await up(connection);
    }

    public async down(): Promise<void> {}
  }

  return MigratorTableInfoLater_2026_10_22_00_01_00;
}

function alterMigration(table: string, alter: (t: AlterTableQueryBuilder) => void): Class<OrmMigration> {
  return laterMigration(async (connection) => {
    await connection.schema().alterTable(table, alter);
  });
}

describe('sqlite OrmMigrator table info re-read', function () {
  this.timeout(20000);

  let schema: ReturnType<typeof defineSchema>;
  let alter: Class<OrmMigration> | undefined;
  let connects: sinon.SinonSpy;

  const columns = (model: Class<ModelBase>) => extractModelDescriptor(model)!.Columns;
  const names = (model: Class<ModelBase>) => columns(model).map((c) => c.Name);

  /** Applies the create migration, then the rest: the second pass re-reads what the first one read. */
  async function migrateInTwoPasses(): Promise<OrmMigrator> {
    const migrator = await DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }]);
    await migrator.migrate({ name: schema.create.name });
    await migrator.migrate();
    return migrator;
  }

  before(() => {
    schema = defineSchema();
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  after(() => {
    DI.unregister(schema.create);
    DI.unregister(schema.Post);
    DI.unregister(schema.Note);
    DI.unregister(MigratorTableInfoConf);
    DI.clearCache();
  });

  beforeEach(() => {
    DI.clearCache();
    DI.register(MigratorTableInfoConf).as(Configuration);
    connects = sinon.spy(SqliteOrmDriver.prototype, 'connect');
  });

  afterEach(async () => {
    for (const driver of connects.thisValues as SqliteOrmDriver[]) {
      driver.stopHealthCheck();
      await driver.disconnect();
    }

    sinon.restore();

    if (alter) {
      DI.unregister(alter);
      alter = undefined;
    }

    DI.clearCache();
  });

  it('drops the column a migration dropped from the model', async () => {
    alter = alterMigration('mti_posts', (t) => t.dropColumn('Title'));

    const migrator = await DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }]);
    await migrator.migrate({ name: schema.create.name });
    expect(names(schema.Post)).to.include('Title');

    await migrator.migrate();

    expect(names(schema.Post)).to.have.members(['Id', 'Flag']);
  });

  it('knows a renamed column by its new name only', async () => {
    alter = alterMigration('mti_posts', (t) => {
      t.string('Title').rename('Headline');
    });

    await migrateInTwoPasses();

    expect(names(schema.Post)).to.have.members(['Id', 'Headline', 'Flag']);
  });

  it('drops the boolean converter of a column a migration turned into text', async () => {
    alter = alterMigration('mti_posts', (t) => {
      t.string('Flag').modify();
    });

    const migrator = await DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }]);
    await migrator.migrate({ name: schema.create.name });
    expect(columns(schema.Post).find((c) => c.Name === 'Flag')!.Converter?.constructor.name).to.match(/BooleanValueConverter$/);

    await migrator.migrate();

    const flag = columns(schema.Post).find((c) => c.Name === 'Flag')!;
    expect(flag.NativeType).to.match(/^(TEXT|VARCHAR)/i);
    expect(flag.Converter ?? null).to.equal(null);
  });
  it('marks the column a unique-index-only migration covers Unique', async () => {
    alter = laterMigration(async (connection) => {
      await connection.index().unique().table('mti_posts').name('mti_posts_title').columns(['Title']);
    });

    await migrateInTwoPasses();

    expect(columns(schema.Post).find((c) => c.Name === 'Title')!.Unique).to.equal(true);
  });
  it('re-reads only the models whose tables the migration touched', async () => {
    alter = alterMigration('mti_posts', (t) => {
      t.string('Extra');
    });

    const migrator = await DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }]);
    await migrator.migrate({ name: schema.create.name });
    const tableInfo = sinon.spy(SqliteOrmDriver.prototype, 'tableInfo');

    await migrator.migrate();

    const reads = tableInfo.getCalls().map((c) => c.args[0]);
    expect(reads).to.include('mti_posts');
    expect(reads).to.not.include('mti_notes');
    expect(names(schema.Post)).to.include('Extra');
    expect(names(schema.Note)).to.have.members(['Id', 'Body']);
  });
});
