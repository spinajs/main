/**
 * The strict table check against a live MySQL, one throwaway database per test.
 *
 *   npx ts-mocha -p tsconfig.json test/integration/strictTableCheck.test.ts
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README).
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, extractModelDescriptor, Migration, Model, ModelBase, Orm, OrmDriver, OrmException, OrmMigration, Primary, QueryContext } from '@spinajs/orm';
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

const CONNECTION = 'mysql-strict';

/** Settings of the next boot. */
let database = '';
let strictSetting: boolean | undefined;

class StrictMySqlConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: {
          ...(strictSetting === undefined ? {} : { StrictTableCheck: strictSetting }),
          Connections: [{ Driver: 'orm-driver-mysql', Name: CONNECTION, ...SERVER, Database: database, Migration: { Table: 'orm_migrations', OnStartup: true } }],
        },
      },
      (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

async function admin<T>(fn: (driver: MySqlOrmDriver) => Promise<T>): Promise<T> {
  const driver = await DI.child().resolve(MySqlOrmDriver, [{ Name: 'strict-mysql-admin', Driver: 'orm-driver-mysql', ...SERVER, Database: 'mysql' }]);
  await driver.connect();

  try {
    return await fn(driver);
  } finally {
    await driver.disconnect();
  }
}

function definePresent() {
  @Migration(CONNECTION)
  class StrictMySql_2026_10_20_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().createTable('strict_mysql_present', (table) => {
        table.int('Id').primaryKey();
        table.string('Name');
      });
    }

    public async down(connection: OrmDriver): Promise<void> {
      await connection.schema().dropTable('strict_mysql_present');
    }
  }

  @Connection(CONNECTION)
  @Model('strict_mysql_present')
  class StrictMySqlPresent extends ModelBase {
    @Primary()
    public Id: number;

    public Name: string;
  }

  return { migration: StrictMySql_2026_10_20_00_00_00, Present: StrictMySqlPresent };
}

function defineMissing() {
  @Connection(CONNECTION)
  @Model('strict_mysql_missing')
  class StrictMySqlMissing extends ModelBase {
    @Primary()
    public Id: number;
  }

  return StrictMySqlMissing;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }

  return undefined;
}

describe('MySQL integration - strict table check', function () {
  this.timeout(60000);

  let schema: ReturnType<typeof definePresent>;
  let Missing: ReturnType<typeof defineMissing> | undefined;
  let connects: sinon.SinonSpy;

  before(() => {
    schema = definePresent();
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
  });

  after(() => {
    DI.unregister(schema.migration);
    DI.unregister(schema.Present);
    DI.unregister(StrictMySqlConf);
    DI.clearCache();
  });

  beforeEach(async () => {
    DI.clearCache();
    strictSetting = undefined;
    database = `orm_strict_${randomUUID().slice(0, 8)}`;
    await admin(async (d) => {
      await d.schema().createDatabase(database);
    });
    DI.register(StrictMySqlConf).as(Configuration);
    connects = sinon.spy(MySqlOrmDriver.prototype, 'connect');
  });

  afterEach(async () => {
    for (const driver of connects.thisValues as MySqlOrmDriver[]) {
      driver.stopHealthCheck();
      await driver.disconnect();
    }

    sinon.restore();

    if (Missing) {
      DI.unregister(Missing);
      Missing = undefined;
    }

    DI.clearCache();
    await admin((d) => d.executeOnDb(`DROP DATABASE IF EXISTS \`${database}\``, [], QueryContext.Schema));
  });

  it('fails the Orm resolve after its migrations, naming the model, its table and its connection', async () => {
    Missing = defineMissing();

    const err = await rejection(Promise.resolve(DI.resolve(Orm)));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.equal('Missing tables (db.StrictTableCheck): model StrictMySqlMissing: table strict_mysql_missing on connection mysql-strict. Create them (run their migrations) or set db.StrictTableCheck to false');
  });

  it('boots when the migration pass created every table', async () => {
    await (await DI.resolve(Orm)).Migrator.ready();

    expect(extractModelDescriptor(schema.Present)!.Columns.map((c) => c.Name)).to.include('Name');
  });

  it('boots with db.StrictTableCheck false and binds the model whose table is missing', async () => {
    Missing = defineMissing();
    strictSetting = false;

    const orm = await DI.resolve(Orm);
    await orm.Migrator.ready();

    expect(extractModelDescriptor(Missing)!.Driver).to.equal(orm.Connections.get(CONNECTION));
  });
});
