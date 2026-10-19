import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Int64, Model, ModelBase, Orm, OrmException, Primary } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

@Connection('sqlite')
@Model('gap_int64')
class GapInt64 extends ModelBase {
  @Primary()
  public Id: number;

  @Int64('string')
  public Counter: string;

  @Int64('bigint')
  public Big: bigint;

  @Int64('number')
  public Small: number;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

describe('sqlite @Int64 columns', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('gap_int64', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.bigint('Counter');
        table.bigint('Big');
        table.bigint('Small');
      });
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('hydrates each column as its declared JS type', async () => {
    const model = new GapInt64({ Counter: '42', Big: 42n, Small: 42 });
    await GapInt64.insert(model);

    const read = (await GapInt64.where('Id', model.Id).first()) as GapInt64;

    expect(read.Counter).to.eq('42');
    expect(read.Big).to.eq(42n);
    expect(read.Small).to.eq(42);
  });

  it('writes bigint and string values through Model.update', async () => {
    const model = new GapInt64({ Counter: '1', Big: 1n, Small: 1 });
    await GapInt64.insert(model);

    await GapInt64.update({ Counter: '44', Big: 43n }).where('Id', model.Id);

    const read = (await GapInt64.where('Id', model.Id).first()) as GapInt64;
    expect(read.Counter).to.eq('44');
    expect(read.Big).to.eq(43n);
  });

  it('refuses a value beyond 2^53 that sqlite3 already rounded', async () => {
    await driver().insert().into('gap_int64').values({ Id: 99, Counter: '9007199254740993' });

    await expect(GapInt64.where('Id', 99).first()).to.be.rejectedWith(OrmException, 'precision');
  });
});
