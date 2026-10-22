import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Class, DI } from '@spinajs/di';
import { Connection, extractModelDescriptor, Migration, Model, ModelBase, OrmDriver, OrmMigration, OrmMigrator, Primary } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import { randomBytes } from 'node:crypto';
import * as sinon from 'sinon';
import '@spinajs/log';

import { PostgresOrmDriver } from '../../src/index.js';
import { adminQuery, PG_SERVER, requirePostgres } from './support.js';

const CONNECTION = 'pg-mti';

let database = '';

class MigratorTableInfoPgConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: {
          StrictTableCheck: false,
          Connections: [{ Driver: 'orm-driver-postgres', Name: CONNECTION, ...PG_SERVER, Database: database, Migration: { Table: 'orm_migrations', OnStartup: true } }],
        },
      },
      (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

function defineSchema() {
  @Migration(CONNECTION)
  class MigratorTableInfoPgCreate_2026_10_22_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().createTable('mti_pg_posts', (table) => {
        table.int('Id').primaryKey();
        table.string('Title');
      });

      await connection.schema().createTable('mti_pg_notes', (table) => {
        table.int('Id').primaryKey();
        table.string('Body');
      });
    }

    public async down(): Promise<void> {}
  }

  @Migration(CONNECTION)
  class MigratorTableInfoPgAlter_2026_10_22_00_01_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().alterTable('mti_pg_posts', (table) => {
        table.string('Extra');
        table.dropColumn('Title');
      });
    }

    public async down(): Promise<void> {}
  }

  @Connection(CONNECTION)
  @Model('mti_pg_posts')
  class MigratorTableInfoPgPost extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Connection(CONNECTION)
  @Model('mti_pg_notes')
  class MigratorTableInfoPgNote extends ModelBase {
    @Primary()
    public Id: number;
  }

  return { create: MigratorTableInfoPgCreate_2026_10_22_00_00_00, alter: MigratorTableInfoPgAlter_2026_10_22_00_01_00, Post: MigratorTableInfoPgPost, Note: MigratorTableInfoPgNote };
}

describe('postgres OrmMigrator table info re-read (integration)', function () {
  this.timeout(60000);

  let schema: ReturnType<typeof defineSchema> | undefined;
  let connects: sinon.SinonSpy;

  const names = (model: Class<ModelBase>) => extractModelDescriptor(model)!.Columns.map((c) => c.Name);

  before(async function () {
    await requirePostgres(this);
    schema = defineSchema();
    DI.register(PostgresOrmDriver).as('orm-driver-postgres');
  });

  after(() => {
    if (schema) {
      Object.values(schema).forEach((t) => DI.unregister(t));
    }

    DI.unregister(MigratorTableInfoPgConf);
    DI.clearCache();
  });

  beforeEach(async () => {
    DI.clearCache();
    database = `orm_mti_${randomBytes(4).toString('hex')}`;
    await adminQuery(`CREATE DATABASE "${database}"`);
    DI.register(MigratorTableInfoPgConf).as(Configuration);
    connects = sinon.spy(PostgresOrmDriver.prototype, 'connect');
  });

  afterEach(async () => {
    for (const driver of connects.thisValues as PostgresOrmDriver[]) {
      driver.stopHealthCheck();
      await driver.disconnect();
    }

    sinon.restore();
    DI.clearCache();
    await adminQuery(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  });

  it('re-reads only the models whose tables the migration touched, with the columns the table has now', async () => {
    const migrator = await DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }]);
    await migrator.migrate({ name: schema!.create.name });
    expect(names(schema!.Post)).to.have.members(['Id', 'Title']);

    const tableInfo = sinon.spy(PostgresOrmDriver.prototype, 'tableInfo');
    await migrator.migrate();

    const reads = tableInfo.getCalls().map((c) => c.args[0]);
    expect(reads).to.include('mti_pg_posts');
    expect(reads).to.not.include('mti_pg_notes');
    expect(names(schema!.Post)).to.have.members(['Id', 'Extra']);
    expect(names(schema!.Note)).to.have.members(['Id', 'Body']);
  });
});
