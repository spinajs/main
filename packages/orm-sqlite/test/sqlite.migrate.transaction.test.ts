/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '../src/index';
import { DI } from '@spinajs/di';
import { Orm, MigrationTransactionMode, QueryContext, OrmMigration, OrmDriver, Migration } from '@spinajs/orm';
import * as _ from 'lodash';
import * as chai from 'chai';
import * as sinon from 'sinon';
import { TEST_MIGRATION_TABLE_NAME, db } from './sqlite.test';
import { dir, mergeArrays } from './util';

export class ConnectionConf extends FrameworkConfiguration {
  public async resolveAsync(): Promise<void> {
    await super.resolveAsync();

    _.mergeWith(
      this.Config,
      {
        system: {
          dirs: {
            models: [dir('./models')],
            migrations: [dir('./migrations')],
          },
        },
        db: {
          Migration: {
            Startup: false,
          },
          Connections: [
            {
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'sqlite',
              Migration: {
                Table: TEST_MIGRATION_TABLE_NAME,

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

const expect = chai.expect;
const sandbox = sinon.createSandbox();

const sql = async () => {
  const driver = DI.resolve<SqliteOrmDriver>('orm-driver-sqlite');

  sandbox.spy(driver, 'transaction');
  sandbox.spy(driver, 'execute');

  await driver.connect();
  return driver;
};

describe('Sqlite driver migrate with transaction', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    sandbox.restore();
    DI.clear();
  });

  it('Should commit migration', async () => {
    const driver = await sql();
    await db().migrateUp();

    expect((driver.transaction as any).calledOnce).to.be.true;
    expect((driver.execute as any).getCall(4).args[0]).to.eq('BEGIN TRANSACTION');
    expect((driver.execute as any).getCall(8).args[0]).to.eq('COMMIT');

    expect(driver.execute('SELECT * FROM user', null, QueryContext.Select)).to.be.fulfilled;

    const result = (await driver.execute(`SELECT * FROM ${TEST_MIGRATION_TABLE_NAME}`, null, QueryContext.Select)) as unknown[];
    expect(result[0]).to.be.not.undefined;
    expect(result[0]).to.be.not.null;
    expect((result[0] as any).Migration).to.eq('TestMigration');
  });

  it('Should rollback migration', async () => {
    @Migration('sqlite')
    class MigrationFailed extends OrmMigration {
      public async up(connection: OrmDriver): Promise<void> {
        await connection.insert().into('not_exists').values({ id: 1 });
      }
      public down(_connection: OrmDriver): Promise<void> {
        return;
      }
    }

    class Fake2Orm extends Orm {
      constructor() {
        super();

        this.Migrations.length = 0;
        this.Models.length = 0;
        this.registerMigration(MigrationFailed);
      }
    }
    const container = DI.child();
    container.register(Fake2Orm).as(Orm);
    const orm = await container.resolve(Orm);
    await orm.migrateUp();

    const driver = await sql();

    expect((driver.transaction as any).calledOnce).to.be.true;
    expect((driver.execute as any).getCall(4).args[0]).to.eq('BEGIN TRANSACTION');
    expect((driver.execute as any).getCall(6).args[0]).to.eq('ROLLBACK');

    expect(driver.execute('SELECT * FROM user', null, QueryContext.Select)).to.be.rejected;
    const result = (await driver.execute(`SELECT * FROM ${TEST_MIGRATION_TABLE_NAME}`, null, QueryContext.Select)) as unknown[];
    expect(result.length).to.be.eq(0);
  });
});
