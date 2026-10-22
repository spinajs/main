import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, extractModelDescriptor, Migration, Model, ModelBase, Orm, OrmDriver, OrmException, OrmMigration, Primary, OrmMigrator } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import { randomBytes } from 'node:crypto';
import * as sinon from 'sinon';
import '@spinajs/log';

import { PostgresOrmDriver } from '../../src/index.js';
import { adminQuery, PG_SERVER, requirePostgres } from './support.js';

const CONNECTION = 'pg-strict';

/** Settings of the next boot. */
let database = '';
let strictSetting: boolean | undefined;

class StrictPgConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: {
          ...(strictSetting === undefined ? {} : { StrictTableCheck: strictSetting }),
          Connections: [{ Driver: 'orm-driver-postgres', Name: CONNECTION, ...PG_SERVER, Database: database, Migration: { Table: 'orm_migrations', OnStartup: true } }],
        },
      },
      (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

function definePresent() {
  @Migration(CONNECTION)
  class StrictPg_2026_10_20_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().createTable('strict_pg_present', (table) => {
        table.int('Id').primaryKey();
        table.string('Name');
      });
    }

    public async down(connection: OrmDriver): Promise<void> {
      await connection.schema().dropTable('strict_pg_present');
    }
  }

  @Connection(CONNECTION)
  @Model('strict_pg_present')
  class StrictPgPresent extends ModelBase {
    @Primary()
    public Id: number;

    public Name: string;
  }

  return { migration: StrictPg_2026_10_20_00_00_00, Present: StrictPgPresent };
}

function defineMissing() {
  @Connection(CONNECTION)
  @Model('strict_pg_missing')
  class StrictPgMissing extends ModelBase {
    @Primary()
    public Id: number;
  }

  return StrictPgMissing;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }

  return undefined;
}

describe('postgres strict table check (integration)', function () {
  this.timeout(60000);

  let schema: ReturnType<typeof definePresent> | undefined;
  let Missing: ReturnType<typeof defineMissing> | undefined;
  let connects: sinon.SinonSpy;

  before(async function () {
    await requirePostgres(this);
    schema = definePresent();
    DI.register(PostgresOrmDriver).as('orm-driver-postgres');
  });

  after(() => {
    if (schema) {
      DI.unregister(schema.migration);
      DI.unregister(schema.Present);
    }

    DI.unregister(StrictPgConf);
    DI.clearCache();
  });

  beforeEach(async () => {
    DI.clearCache();
    strictSetting = undefined;
    database = `orm_strict_${randomBytes(4).toString('hex')}`;
    await adminQuery(`CREATE DATABASE "${database}"`);
    DI.register(StrictPgConf).as(Configuration);
    connects = sinon.spy(PostgresOrmDriver.prototype, 'connect');
  });

  afterEach(async () => {
    for (const driver of connects.thisValues as PostgresOrmDriver[]) {
      driver.stopHealthCheck();
      await driver.disconnect();
    }

    sinon.restore();

    if (Missing) {
      DI.unregister(Missing);
      Missing = undefined;
    }

    DI.clearCache();
    await adminQuery(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  });

  it('fails the migrator boot after the migration pass, naming the model, its table and its connection', async () => {
    Missing = defineMissing();

    await DI.resolve(Orm);
    const err = await rejection(Promise.resolve(DI.resolve(OrmMigrator)));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.equal('Missing tables (db.StrictTableCheck): model StrictPgMissing: table strict_pg_missing on connection pg-strict. Create them (run their migrations) or set db.StrictTableCheck to false');
  });

  it('boots when the migration pass created every table', async () => {
    await DI.resolve(OrmMigrator);

    expect(extractModelDescriptor(schema!.Present)!.Columns.map((c) => c.Name)).to.include('Name');
  });

  it('boots with db.StrictTableCheck false and binds the model whose table is missing', async () => {
    Missing = defineMissing();
    strictSetting = false;

    const orm = await DI.resolve(Orm);
    await DI.resolve(OrmMigrator);

    expect(extractModelDescriptor(Missing)!.Driver).to.equal(orm.Connections.get(CONNECTION));
  });
});
