import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, extractModelDescriptor, Migration, Model, ModelBase, Orm, OrmDriver, OrmException, OrmMigration, OrmMigrator, Primary } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import * as sinon from 'sinon';
import '@spinajs/log';

import { SqliteOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';

const CONNECTION = 'sqlite-strict';

/** Settings of the next boot. */
let strictSetting: boolean | undefined;
let onStartup = true;

class StrictSqliteConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: {
          ...(strictSetting === undefined ? {} : { StrictTableCheck: strictSetting }),
          Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: CONNECTION, Migration: { Table: 'orm_migrations_strict', OnStartup: onStartup } }],
        },
      },
      mergeArrays,
    );
  }
}

function definePresent() {
  @Migration(CONNECTION)
  class StrictSqlite_2026_10_20_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().createTable('strict_sqlite_present', (table) => {
        table.int('Id').primaryKey();
        table.string('Name');
      });
    }

    public async down(connection: OrmDriver): Promise<void> {
      await connection.schema().dropTable('strict_sqlite_present');
    }
  }

  @Connection(CONNECTION)
  @Model('strict_sqlite_present')
  class StrictSqlitePresent extends ModelBase {
    @Primary()
    public Id: number;

    public Name: string;
  }

  return { migration: StrictSqlite_2026_10_20_00_00_00, Present: StrictSqlitePresent };
}

function defineMissing() {
  @Connection(CONNECTION)
  @Model('strict_sqlite_missing')
  class StrictSqliteMissing extends ModelBase {
    @Primary()
    public Id: number;
  }

  return StrictSqliteMissing;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }

  return undefined;
}

describe('sqlite strict table check (db.StrictTableCheck)', function () {
  this.timeout(20000);

  let schema: ReturnType<typeof definePresent>;
  let Missing: ReturnType<typeof defineMissing> | undefined;
  let connects: sinon.SinonSpy;

  before(() => {
    schema = definePresent();
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  after(() => {
    DI.unregister(schema.migration);
    DI.unregister(schema.Present);
    DI.unregister(StrictSqliteConf);
    DI.clearCache();
  });

  beforeEach(() => {
    DI.clearCache();
    strictSetting = undefined;
    onStartup = true;
    DI.register(StrictSqliteConf).as(Configuration);
    connects = sinon.spy(SqliteOrmDriver.prototype, 'connect');
  });

  afterEach(async () => {
    for (const driver of connects.thisValues as SqliteOrmDriver[]) {
      driver.stopHealthCheck();
      await driver.disconnect();
    }

    sinon.restore();

    if (Missing) {
      DI.unregister(Missing);
      Missing = undefined;
    }

    DI.clearCache();
  });

  it('fails the migrator boot after the migration pass, naming the model, its table and its connection', async () => {
    Missing = defineMissing();

    await DI.resolve(Orm);
    const err = await rejection(Promise.resolve(DI.resolve(OrmMigrator)));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.equal('Missing tables (db.StrictTableCheck): model StrictSqliteMissing: table strict_sqlite_missing on connection sqlite-strict. Create them (run their migrations) or set db.StrictTableCheck to false');
  });

  it('leaves the resolved Orm connected when the strict boot check fails; disposing it disconnects the driver', async () => {
    Missing = defineMissing();
    const disconnect = sinon.spy(SqliteOrmDriver.prototype, 'disconnect');
    const stopHealthCheck = sinon.spy(SqliteOrmDriver.prototype, 'stopHealthCheck');

    const orm = await DI.resolve(Orm);
    expect(await rejection(Promise.resolve(DI.resolve(OrmMigrator)))).to.be.instanceOf(OrmException);

    expect(connects.callCount).to.equal(1);
    expect(disconnect.called).to.equal(false);

    await orm.dispose();

    expect(stopHealthCheck.called).to.equal(true);
    expect(disconnect.callCount).to.equal(1);
  });

  it('boots when the migration pass created every table', async () => {
    const orm = await DI.resolve(Orm);
    await DI.resolve(OrmMigrator);

    expect(extractModelDescriptor(schema.Present)!.Driver).to.equal(orm.Connections.get(CONNECTION));
  });

  it('boots with db.StrictTableCheck false and binds the model whose table is missing', async () => {
    Missing = defineMissing();
    strictSetting = false;

    const orm = await DI.resolve(Orm);
    await DI.resolve(OrmMigrator);

    expect(extractModelDescriptor(Missing)!.Driver).to.equal(orm.Connections.get(CONNECTION));
  });

  it('migrates after a lenient boot and then checks with reloadTableInfo({ strict: true })', async () => {
    onStartup = false;
    strictSetting = false;

    const orm = await DI.resolve(Orm);
    expect(await rejection(orm.reloadTableInfo({ strict: true }))).to.be.instanceOf(OrmException);

    await (await DI.resolve(OrmMigrator)).Runner.up();
    await orm.reloadTableInfo({ strict: true });
  });

  it('resolves a migrator with MigrateOnStartup: false before the tables exist; migrate() creates them', async () => {
    const migrator = await DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }]);
    const orm = await DI.resolve(Orm);
    expect(await rejection(orm.reloadTableInfo({ strict: orm.StrictTableCheck }))).to.be.instanceOf(OrmException);

    await migrator.migrate();
    await orm.reloadTableInfo({ strict: orm.StrictTableCheck });
  });
});
