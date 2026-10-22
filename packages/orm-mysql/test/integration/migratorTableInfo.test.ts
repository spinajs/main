import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Class, DI } from '@spinajs/di';
import { Connection, extractModelDescriptor, Migration, Model, ModelBase, OrmDriver, OrmMigration, OrmMigrator, Primary, QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import { randomUUID } from 'node:crypto';
import * as sinon from 'sinon';
import '@spinajs/log';

import { MySqlOrmDriver } from '../../src/index.js';

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};

const CONNECTION = 'mysql-mti';

let database = '';

class MigratorTableInfoMySqlConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: {
          StrictTableCheck: false,
          Connections: [{ Driver: 'orm-driver-mysql', Name: CONNECTION, ...SERVER, Database: database, Migration: { Table: 'orm_migrations', OnStartup: true } }],
        },
      },
      (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

async function admin<T>(fn: (driver: MySqlOrmDriver) => Promise<T>): Promise<T> {
  const driver = await DI.child().resolve(MySqlOrmDriver, [{ Name: 'mti-mysql-admin', Driver: 'orm-driver-mysql', ...SERVER, Database: 'mysql' }]);
  await driver.connect();

  try {
    return await fn(driver);
  } finally {
    await driver.disconnect();
  }
}

function defineSchema() {
  @Migration(CONNECTION)
  class MigratorTableInfoMySqlCreate_2026_10_22_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().createTable('mti_mysql_posts', (table) => {
        table.int('Id').primaryKey();
        table.string('Title');
      });

      await connection.schema().createTable('mti_mysql_notes', (table) => {
        table.int('Id').primaryKey();
        table.string('Body');
      });
    }

    public async down(): Promise<void> {}
  }

  @Migration(CONNECTION)
  class MigratorTableInfoMySqlAlter_2026_10_22_00_01_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().alterTable('mti_mysql_posts', (table) => {
        table.string('Extra');
        table.dropColumn('Title');
      });
    }

    public async down(): Promise<void> {}
  }

  @Connection(CONNECTION)
  @Model('mti_mysql_posts')
  class MigratorTableInfoMySqlPost extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Connection(CONNECTION)
  @Model('mti_mysql_notes')
  class MigratorTableInfoMySqlNote extends ModelBase {
    @Primary()
    public Id: number;
  }

  return { create: MigratorTableInfoMySqlCreate_2026_10_22_00_00_00, alter: MigratorTableInfoMySqlAlter_2026_10_22_00_01_00, Post: MigratorTableInfoMySqlPost, Note: MigratorTableInfoMySqlNote };
}

describe('MySQL integration - OrmMigrator table info re-read', function () {
  this.timeout(60000);

  let schema: ReturnType<typeof defineSchema>;
  let connects: sinon.SinonSpy;

  const names = (model: Class<ModelBase>) => extractModelDescriptor(model)!.Columns.map((c) => c.Name);

  before(() => {
    schema = defineSchema();
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
  });

  after(() => {
    Object.values(schema).forEach((t) => DI.unregister(t));

    DI.unregister(MigratorTableInfoMySqlConf);
    DI.clearCache();
  });

  beforeEach(async () => {
    DI.clearCache();
    database = `orm_mti_${randomUUID().slice(0, 8)}`;
    await admin(async (d) => {
      await d.schema().createDatabase(database);
    });
    DI.register(MigratorTableInfoMySqlConf).as(Configuration);
    connects = sinon.spy(MySqlOrmDriver.prototype, 'connect');
  });

  afterEach(async () => {
    for (const driver of connects.thisValues as MySqlOrmDriver[]) {
      driver.stopHealthCheck();
      await driver.disconnect();
    }

    sinon.restore();
    DI.clearCache();
    await admin((d) => d.executeOnDb(`DROP DATABASE IF EXISTS \`${database}\``, [], QueryContext.Schema));
  });

  it('re-reads only the models whose tables the migration touched, with the columns the table has now', async () => {
    const migrator = await DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }]);
    await migrator.migrate({ name: schema.create.name });
    expect(names(schema.Post)).to.have.members(['Id', 'Title']);

    const tableInfo = sinon.spy(MySqlOrmDriver.prototype, 'tableInfo');
    await migrator.migrate();

    const reads = tableInfo.getCalls().map((c) => c.args[0]);
    expect(reads).to.include('mti_mysql_posts');
    expect(reads).to.not.include('mti_mysql_notes');
    expect(names(schema.Post)).to.have.members(['Id', 'Extra']);
    expect(names(schema.Note)).to.have.members(['Id', 'Body']);
  });
});
