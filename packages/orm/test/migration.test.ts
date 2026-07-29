/* eslint-disable prettier/prettier */
import { NonDbPropertyHydrator } from './../src/hydrators.js';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Class, DI } from '@spinajs/di';
import * as chai from 'chai';
import _ from 'lodash';
import 'mocha';
import { Orm } from '../src/orm.js';
import { FakeSqliteDriver, FakeMysqlDriver, TEST_TABLE_INFO, bootstrapAll, mergeArrays, registerFakes, stubDb } from './misc.js';
import * as sinon from 'sinon';
import { ModelToSqlConverter, DbPropertyHydrator, ModelHydrator, OrmMigration, Migration, MigrationTransactionMode, StandardModelToSqlConverter, ObjectToSqlConverter, StandardObjectToSqlConverter, IMigrationRecord, MIGRATION_TABLE_NAME, OrmException } from '../src/index.js';
import { Migration1_2021_12_01_12_00_00, Migration2_2021_12_02_12_00_00 } from './mocks/migrations/index.js';
import { OrmDriver } from '../src/driver.js';
import '@spinajs/log';
import "./../src/bootstrap.js";

const expect = chai.expect;

const now = new Date();

/**
 * One tracking row in its current shape - applied and not rolled back unless a test says
 * otherwise. `up()` skips a migration only when its row carries `FinishedAt`, so a half-filled
 * row would read as "never applied" and quietly turn a "must not run" test into a green no-op.
 */
const row = (over: Partial<IMigrationRecord>): IMigrationRecord => ({
  Migration: 'X',
  CreatedAt: now,
  StartedAt: now,
  FinishedAt: now,
  RolledBackAt: null,
  Logs: null,
  Checksum: null,
  Batch: 1,
  ...over,
});

async function db() {
  return await DI.resolve(Orm);
}

describe('Orm migrations', () => {
  /**
   * `@Migration()` registers the decorated class into the ROOT container under `__migrations__`
   * and that registration outlives the test that declared it - so the fixture declared inside
   * 'Should register migration programatically' would otherwise still be there when the next
   * test asserts on how many migrations the Orm found.
   *
   * Identity decides what to remove, but `DI.unregister` removes by TYPE NAME across every
   * registry bucket, so a fixture sharing a name with another suite's registration would delete
   * THAT entry instead - see the longer note in `migration-runner.test.ts`.
   */
  let preRegistered: unknown[] = [];

  before(() => {
    registerFakes();
    DI.register(FakeMysqlDriver).as('mysql');

    DI.register(DbPropertyHydrator).as(ModelHydrator);
    DI.register(NonDbPropertyHydrator).as(ModelHydrator);
    DI.register(StandardModelToSqlConverter).as(ModelToSqlConverter);
    DI.register(StandardObjectToSqlConverter).as(ObjectToSqlConverter);
  });

  beforeEach(async () => {
    DI.removeAllListeners('di.resolve.Configuration');

    await bootstrapAll();

    // tracking table already in its current shape, so ensureStorage() has nothing to create or
    // upgrade and the tests below observe only the statements their own migration run issued
    TEST_TABLE_INFO[MIGRATION_TABLE_NAME] = ['Migration', 'CreatedAt', 'StartedAt', 'FinishedAt', 'RolledBackAt', 'Logs', 'Checksum', 'Batch'].map((Name) => ({ Name })) as any;

    // copied, not aliased: getRegisteredTypes hands back the registry's own array, which a
    // decorator running inside a test then pushes into
    preRegistered = [...(DI.getRegisteredTypes('__migrations__') ?? [])];
  });

  afterEach(() => {
    for (const t of [...(DI.getRegisteredTypes('__migrations__') ?? [])]) {
      if (!preRegistered.includes(t)) {
        DI.unregister(t as Class<unknown>);
      }
    }

    delete TEST_TABLE_INFO[MIGRATION_TABLE_NAME];
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
    stubDb([]);
    const up = sinon.stub(Migration1_2021_12_01_12_00_00.prototype, 'up');
    const up2 = sinon.stub(Migration2_2021_12_02_12_00_00.prototype, 'up');

    await orm.Migration.up('Migration1_2021_12_01_12_00_00');

    expect(up.calledOnceWith(orm.Connections.get('sqlite'))).to.be.true;
    expect(up2.called, 'a named run must not drag the rest of the registry along').to.be.false;
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
                    OnStartup: true,
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

    // OnStartup is on for this connection, so resolving the Orm already migrates - the tracking
    // table has to answer before that, not after
    stubDb([]);

    const orm = await container.resolve(Orm);

    // transaction() now owns commit/rollback itself and resolves with the callback's result,
    // so there is no ITransaction handle to fake any more
    const tr = sinon.stub(FakeSqliteDriver.prototype, 'transaction').resolves(undefined);
    await orm.Migration.up();

    // PerMigration means one transaction per migration, and both are pending again because the
    // stubbed tracking table always reports empty
    expect(tr.callCount).to.eq(2);
  });

  it('ORM should run all migrations', async () => {
    // @ts-ignore
    const orm = await db();
    stubDb([]);

    const up = sinon.stub(Migration1_2021_12_01_12_00_00.prototype, 'up');
    const up2 = sinon.stub(Migration2_2021_12_02_12_00_00.prototype, 'up');

    await orm.Migration.up();

    expect(up.calledOnceWith(orm.Connections.get('sqlite'))).to.be.true;
    expect(up2.calledOnceWith(orm.Connections.get('sqlite'))).to.be.true;
  });

  it('Should run migration in proper order up', async () => {
    // @ts-ignore
    const orm = await db();
    stubDb([]);

    const spy1 = sinon.spy(Migration1_2021_12_01_12_00_00.prototype, 'up');
    const spy2 = sinon.spy(Migration2_2021_12_02_12_00_00.prototype, 'up');

    await orm.Migration.up();

    expect(spy1.calledBefore(spy2)).to.be.true;
    expect(spy1.calledOnce).to.be.true;
    expect(spy2.calledOnce).to.be.true;
  });

  it('Should run migration in proper order down', async () => {
    // @ts-ignore
    const orm = await db();

    // seed migration table: both migrations are recorded so down() must fire for both. They sit
    // in different batches, so only { all: true } reaches past the last one
    stubDb([row({ Migration: 'Migration1_2021_12_01_12_00_00', Batch: 1 }), row({ Migration: 'Migration2_2021_12_02_12_00_00', Batch: 2 })]);

    const spy1 = sinon.spy(Migration1_2021_12_01_12_00_00.prototype, 'down');
    const spy2 = sinon.spy(Migration2_2021_12_02_12_00_00.prototype, 'down');

    await orm.Migration.down(undefined, { all: true });

    expect(spy1.calledAfter(spy2)).to.be.true;
    expect(spy1.calledOnce).to.be.true;
    expect(spy2.calledOnce).to.be.true;
  });

  it('Should NOT run down for migrations that are not recorded', async () => {
    // @ts-ignore
    const orm = await db();

    // migration table empty => nothing recorded => down must NOT run
    stubDb([]);

    const spy1 = sinon.spy(Migration1_2021_12_01_12_00_00.prototype, 'down');
    const spy2 = sinon.spy(Migration2_2021_12_02_12_00_00.prototype, 'down');

    await orm.Migration.down(undefined, { all: true });

    expect(spy1.called).to.be.false;
    expect(spy2.called).to.be.false;
  });

  it('Should NOT run up for migrations that are already recorded', async () => {
    // @ts-ignore
    const orm = await db();

    // seed migration table: both migrations already recorded so up() must be skipped
    stubDb([row({ Migration: 'Migration1_2021_12_01_12_00_00' }), row({ Migration: 'Migration2_2021_12_02_12_00_00' })]);

    const spy1 = sinon.spy(Migration1_2021_12_01_12_00_00.prototype, 'up');
    const spy2 = sinon.spy(Migration2_2021_12_02_12_00_00.prototype, 'up');

    await orm.Migration.up();

    expect(spy1.called).to.be.false;
    expect(spy2.called).to.be.false;
  });

  it('data() failures aggregate and every hook still runs', async () => {
    const orm = await db();

    // a data() that throws used to abort the whole phase at the first failure, so every seed
    // after it was silently skipped and only the first error was ever reported
    const d1 = sinon.stub(Migration1_2021_12_01_12_00_00.prototype, 'data').rejects(new Error('seed 1 failed'));
    const d2 = sinon.stub(Migration2_2021_12_02_12_00_00.prototype, 'data').rejects(new Error('seed 2 failed'));

    try {
      await (orm as any).runDataPhase([new Migration1_2021_12_01_12_00_00(), new Migration2_2021_12_02_12_00_00()]);
      expect.fail('a failed data() phase must not resolve');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('seed 1 failed');
      expect(e.message, 'every failure has to be named, not just the first').to.contain('seed 2 failed');
      expect(e.message).to.contain('Migration1_2021_12_01_12_00_00');
      expect(e.message).to.contain('Migration2_2021_12_02_12_00_00');
    }

    expect(d1.calledOnce).to.be.true;
    expect(d2.calledOnce, 'a hook after a failing one still has to run').to.be.true;
  });

  it('migrations discovered purely via DI registration', async () => {
    const orm = await db();

    expect(orm.Migrations.every((m) => typeof m.type === 'function'), 'the registry carries classes, not file paths').to.be.true;
    expect(orm.Migrations.map((m) => m.name)).to.eql(['Migration1_2021_12_01_12_00_00', 'Migration2_2021_12_02_12_00_00']);
    expect(orm.Migrations.map((m) => m.type)).to.eql([Migration1_2021_12_01_12_00_00, Migration2_2021_12_02_12_00_00]);

    const registered = DI.getRegisteredTypes('__migrations__');
    expect(registered).to.include(Migration1_2021_12_01_12_00_00);
    expect(registered).to.include(Migration2_2021_12_02_12_00_00);
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

    // OnStartup is on, so the boot run is what exercises the programmatic registration
    stubDb([]);

    const orm = await container.resolve(Orm);
    const migrations = orm.Migrations;

    expect(migrations.find((m) => m.name === 'Test_2021_12_02_12_00_00'), 'a DI-registered migration has to reach the Orm registry').to.not.be.undefined;
    expect(fakeUp.calledOnce).to.be.true;
  });

  it('Should refuse a migration whose name carries no timestamp', async () => {
    @Migration('sqlite')
    class MigrationTest_Malformed extends OrmMigration {
      public async up(_: OrmDriver) {}
      public async down(_: OrmDriver) {}
    }

    expect(DI.getRegisteredTypes('__migrations__'), 'the decorator registers it regardless of the name').to.include(MigrationTest_Malformed);

    // registerMigration validates at boot, so the Orm never comes up holding a migration that
    // cannot be ordered - a half-ordered run applies schema changes in an order nobody described
    try {
      await db();
      expect.fail('an unorderable migration must not boot');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('MigrationTest_Malformed');
      expect(e.message).to.contain('some_name_yyyy_MM_dd_HH_mm_ss');
    }
  });
});
