import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, IContainer } from '@spinajs/di';
import { Connection, extractModelDescriptor, Migration, Model, ModelBase, Orm, OrmDriver, OrmException, OrmMigration, PendingMigrationsException, Primary, resolveMigrationTool } from '@spinajs/orm';
import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import _ from 'lodash';
import 'mocha';
import * as sinon from 'sinon';
import '@spinajs/log';

import { SqliteOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';

const CONNECTION = 'sqlite-strict';

/** Settings of the next boot. */
let strictSetting: boolean | undefined;
let dbFile = '';

class StrictSqliteConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: {
          ...(strictSetting === undefined ? {} : { StrictTableCheck: strictSetting }),
          Connections: [{ Driver: 'orm-driver-sqlite', Filename: dbFile, Name: CONNECTION, Migration: { Table: 'orm_migrations_strict' } }],
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
  let dir = '';

  /** A migrate-up run in a container of its own, on the file the application then boots on, as in a deploy. */
  async function migrateUp(): Promise<void> {
    const tool: IContainer = DI.child();
    const migrator = await resolveMigrationTool(tool);
    await migrator.migrate();
    await migrator.Orm.dispose();
  }

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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-strict-'));
    dbFile = path.join(dir, 'strict.sqlite');
    strictSetting = undefined;
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
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails the Orm resolve after migrate-up, naming the model, its table and its connection', async () => {
    Missing = defineMissing();
    await migrateUp();

    const err = await rejection(Promise.resolve(DI.child().resolve(Orm)));

    expect(err).to.be.instanceOf(OrmException);
    expect(err).to.not.be.instanceOf(PendingMigrationsException);
    expect((err as Error).message).to.equal('Missing tables (db.StrictTableCheck): model StrictSqliteMissing: table strict_sqlite_missing on connection sqlite-strict. Create them (run their migrations) or set db.StrictTableCheck to false');
  });

  it('names the pending migration, not the missing tables, on a database migrate-up never ran on', async () => {
    Missing = defineMissing();

    const err = await rejection(Promise.resolve(DI.child().resolve(Orm)));

    expect(err).to.be.instanceOf(PendingMigrationsException);
    expect((err as PendingMigrationsException).pending.map((m) => m.name)).to.deep.equal([schema.migration.name]);
  });

  it('closes its connection when the strict check fails the Orm resolve', async () => {
    Missing = defineMissing();
    await migrateUp();
    connects.resetHistory();
    const disconnect = sinon.spy(SqliteOrmDriver.prototype, 'disconnect');
    const stopHealthCheck = sinon.spy(SqliteOrmDriver.prototype, 'stopHealthCheck');

    expect(await rejection(Promise.resolve(DI.child().resolve(Orm)))).to.be.instanceOf(OrmException);

    expect(connects.callCount).to.equal(1);
    expect(stopHealthCheck.called).to.equal(true);
    expect(disconnect.callCount).to.equal(1);
  });

  it('boots when migrate-up created every table', async () => {
    await migrateUp();

    const orm = await DI.child().resolve(Orm);

    expect(extractModelDescriptor(schema.Present)!.Driver).to.equal(orm.Connections.get(CONNECTION));
  });

  it('boots with db.StrictTableCheck false and binds the model whose table is missing', async () => {
    Missing = defineMissing();
    strictSetting = false;
    await migrateUp();

    const orm = await DI.child().resolve(Orm);

    expect(extractModelDescriptor(Missing)!.Driver).to.equal(orm.Connections.get(CONNECTION));
  });

  it('migrates after a tool boot with Runner.up() and then checks with reloadTableInfo({ strict: true })', async () => {
    strictSetting = false;

    const { Orm: orm, Runner } = await resolveMigrationTool();
    expect(await rejection(orm.reloadTableInfo({ strict: true }))).to.be.instanceOf(OrmException);

    await Runner.up();
    await orm.reloadTableInfo({ strict: true });
  });

  it('resolveMigrationTool() boots before the tables exist; migrate() creates them', async () => {
    const migrator = await resolveMigrationTool();
    const orm = await DI.resolve(Orm);
    expect(await rejection(orm.reloadTableInfo({ strict: orm.StrictTableCheck }))).to.be.instanceOf(OrmException);

    await migrator.migrate();
    await orm.reloadTableInfo({ strict: orm.StrictTableCheck });
  });
});
