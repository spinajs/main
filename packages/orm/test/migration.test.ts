/* eslint-disable prettier/prettier */
import { NonDbPropertyHydrator } from './../src/hydrators.js';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import * as chai from 'chai';
import _ from 'lodash';
import 'mocha';
import { Orm } from '../src/orm.js';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, ConnectionConf, FakeMysqlDriver, FakeTableQueryCompiler, FakeColumnQueryCompiler, mergeArrays, FakeTableExistsCompiler } from './misc.js';
import * as sinon from 'sinon';
import { ModelToSqlConverter, SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, DbPropertyHydrator, ModelHydrator, OrmMigration, Migration, TableExistsCompiler, TableQueryCompiler, ColumnQueryCompiler, MigrationTransactionMode, StandardModelToSqlConverter, ObjectToSqlConverter, StandardObjectToSqlConverter } from '../src/index.js';
import { Migration1_2021_12_01_12_00_00, Migration2_2021_12_02_12_00_00 } from './mocks/migrations/index.js';
import { OrmDriver } from '../src/driver.js';
import "./../src/bootstrap.js";

const expect = chai.expect;

async function db() {
  return await DI.resolve(Orm);
}

describe('Orm migrations', () => {
  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    DI.register(FakeMysqlDriver).as('mysql');

    DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
    DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
    DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
    DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
    DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);
    DI.register(FakeColumnQueryCompiler).as(ColumnQueryCompiler);
    DI.register(FakeTableExistsCompiler).as(TableExistsCompiler);

    DI.register(DbPropertyHydrator).as(ModelHydrator);
    DI.register(NonDbPropertyHydrator).as(ModelHydrator);
    DI.register(StandardModelToSqlConverter).as(ModelToSqlConverter);
    DI.register(StandardObjectToSqlConverter).as(ObjectToSqlConverter);
  });

  beforeEach(async () =>{ 

    DI.removeAllListeners("di.resolve.Configuration");

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }
  })

  afterEach(async () => {
    DI.clearCache();
    sinon.restore();
  });

  it('ORM should load migrations', async () => {
    // @ts-ignore
    const orm = await db();

    expect(orm.Migrations).to.be.an('array').with.length(2);
    expect(orm.Migrations[0].type.name).to.eq('Migration1_2021_12_01_12_00_00');
  });

  it('ORM should run migration by name', async () => {
    const orm = await db();
    const up = sinon.stub(Migration1_2021_12_01_12_00_00.prototype, 'up');
    await orm.migrateUp('Migration1_2021_12_01_12_00_00');

    expect(up.calledOnceWith(orm.Connections.get('sqlite'))).to.be.true;
  });

  it('ORM should run migration in transaction scope', async () => {
    class FakeConf extends FrameworkConfiguration {
      public async resolve(): Promise<void> {
        await super.resolve();

        _.mergeWith(
          this.Config,
          {
            logger: {
              targets: [
                {
                  name: 'Empty',
                  type: 'BlackHoleTarget',
                },
              ],

              rules: [{ name: '*', level: 'trace', target: 'Empty' }],
            },
            db: {
              Connections: [
                {
                  Driver: 'sqlite',
                  Filename: 'foo.sqlite',
                  Name: 'sqlite',
                  Migration: {
                    Startup: true,
                    Transaction: {
                      Mode: MigrationTransactionMode.PerMigration,
                    },
                  },
                },
              ],
            },
          },

          mergeArrays,
        );
      }
    }

    const container = DI.child();
    container.register(FakeConf).as(Configuration);

    const orm = await container.resolve(Orm);

    const tr = sinon.stub(FakeSqliteDriver.prototype, 'transaction');
    await orm.migrateUp();

    expect(tr.called).to.be.true;
  });

  it('ORM should run all migrations', async () => {
    // @ts-ignore
    const orm = await db();

    const up = sinon.stub(Migration1_2021_12_01_12_00_00.prototype, 'up');
    const up2 = sinon.stub(Migration2_2021_12_02_12_00_00.prototype, 'up');

    await orm.migrateUp();

    expect(up.calledOnceWith(orm.Connections.get('sqlite'))).to.be.true;
    expect(up2.calledOnceWith(orm.Connections.get('sqlite'))).to.be.true;
  });

  it('Should run migration in proper order up', async () => {
    // @ts-ignore
    const orm = await db();

    const spy1 = sinon.spy(Migration1_2021_12_01_12_00_00.prototype, 'up');
    const spy2 = sinon.spy(Migration2_2021_12_02_12_00_00.prototype, 'up');

    await orm.migrateUp();

    expect(spy1.calledBefore(spy2));
    expect(spy1.calledOnce);
    expect(spy2.calledOnce);
  });

  it('Should run migration in proper order down', async () => {
    // @ts-ignore
    const orm = await db();

    const spy1 = sinon.spy(Migration1_2021_12_01_12_00_00.prototype, 'down');
    const spy2 = sinon.spy(Migration2_2021_12_02_12_00_00.prototype, 'down');

    await orm.migrateDown();

    expect(spy1.calledAfter(spy2));
    expect(spy1.calledOnce);
    expect(spy2.calledOnce);
  });

  it('Should register migration programatically', async () => {
    class FakeConf extends FrameworkConfiguration {
      public async resolve(): Promise<void> {
        await super.resolve();

        _.mergeWith(
          this.Config,
          {
            logger: {
              targets: [
                {
                  name: 'Empty',
                  type: 'BlackHoleTarget',
                },
              ],

              rules: [{ name: '*', level: 'trace', target: 'Empty' }],
            },
            db: {
              Connections: [
                {
                  Driver: 'sqlite',
                  Filename: 'foo.sqlite',
                  Name: 'sqlite',
                  Migration: {
                    OnStartup: true,
                    Transaction: {
                      Mode: MigrationTransactionMode.None,
                    },
                  },
                },
              ],
            },
          },

          mergeArrays,
        );
      }
    }

    @Migration('sqlite')
    class Test_2021_12_02_12_00_00 extends OrmMigration {
      public async up(_: OrmDriver) {}
      public async down(_: OrmDriver) {}
    }

    class FakeOrm extends Orm {
      constructor() {
        super();
      }
    }

    const fakeUp = sinon.spy(Test_2021_12_02_12_00_00.prototype, 'up');

    const container = DI.child();
    container.register(FakeConf).as(Configuration);
    container.register(FakeOrm).as(Orm);

    const orm = await container.resolve(Orm);
    const migrations = await orm.Migrations;

    expect(migrations.find((m) => m.name === 'Test')).to.be.not.null;
    expect(fakeUp.calledOnce).to.be.true;
  });
});
