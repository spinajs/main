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

function alterMigration(table: string, alter: (t: AlterTableQueryBuilder) => void): Class<OrmMigration> {
  @Migration(CONNECTION)
  class MigratorTableInfoAlter_2026_10_22_00_01_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().alterTable(table, alter);
    }

    public async down(): Promise<void> {}
  }

  return MigratorTableInfoAlter_2026_10_22_00_01_00;
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
});
