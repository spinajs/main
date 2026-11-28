import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Connection, Model, ModelBase, Orm, Primary } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;

@Connection('sqlite')
@Model('win_row')
class Row extends ModelBase<Row> {
  @Primary()
  public Id: number;

  public N: number;
}

async function rejection(run: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  return undefined;
}

async function ids(): Promise<number[]> {
  return (await Row.all()).map((r) => r.Id).sort();
}

describe('sqlite: an IN list holding NaN is refused, not bound as NULL', function () {
  this.timeout(20000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await db()
      .Connections.get('sqlite')!
      .schema()
      .createTable('win_row', (table) => {
        table.int('Id').primaryKey();
        table.int('N');
      });
    await db().reloadTableInfo();

    for (let n = 1; n <= 3; n++) {
      await Row.insert({ Id: n, N: n });
    }
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('whereNotIn(column, [NaN]) throws instead of returning no rows', async () => {
    const error = await rejection(async () => await Row.query().whereNotIn('N', [NaN]));

    expect(error).to.be.instanceOf(InvalidArgument);
    expect((error as InvalidArgument).message).to.eq('value cannot be NaN');
  });

  it('a delete narrowed by whereNotIn(column, [2, NaN]) throws and deletes nothing', async () => {
    const connection = db().Connections.get('sqlite')!;
    const error = await rejection(async () => await connection.del().from('win_row').whereNotIn('N', [2, NaN]));

    expect(error).to.be.instanceOf(InvalidArgument);
    expect(await ids()).to.deep.eq([1, 2, 3]);
  });

  it('Model.find() with a NaN key throws', async () => {
    expect(await rejection(() => Row.find([1, NaN]))).to.be.instanceOf(InvalidArgument);
  });

  it('a list without NaN still selects as before', async () => {
    expect((await Row.query().whereNotIn('N', [2])).map((r) => r.Id)).to.deep.eq([1, 3]);
    expect((await Row.query().whereIn('N', [1, 3])).map((r) => r.Id)).to.deep.eq([1, 3]);
  });
});
