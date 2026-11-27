import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

const insert = (Name: string) => driver().insert().into('ps_row').values({ Name });
const names = async (): Promise<string[]> => (await driver().select<Array<{ Name: string }>>().from('ps_row').orderBy('Name')).map((r) => r.Name);

describe('sqlite savepoints started together inside one transaction', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('ps_row', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.string('Name');
      });
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('commits each savepoint with its own rows only', async () => {
    const outcomes = await driver().transaction(async () => {
      await insert('caller');
      return Promise.allSettled([
        driver().transaction(async () => {
          await insert('a1');
          await tick();
          await insert('a2');
        }),
        driver().transaction(async () => {
          await insert('b1');
          throw new Error('b fails');
        }),
      ]);
    });

    expect(outcomes.map((o) => o.status)).to.deep.equal(['fulfilled', 'rejected']);
    expect(await names()).to.deep.equal(['a1', 'a2', 'caller']);
  });
});
