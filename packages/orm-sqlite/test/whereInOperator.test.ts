import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

function rows() {
  return driver().select().select('N').from('in_operator').orderBy('N');
}

async function numbers(query: ReturnType<typeof rows>): Promise<number[]> {
  const result = await query.asRaw<{ N: number }[]>();
  return result.map((r) => r.N);
}

describe('sqlite where() with the in / not in operator', function () {
  this.timeout(30000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('in_operator', (table) => {
        table.int('N').primaryKey();
      });
    await driver()
      .schema()
      .createTable('in_operator_picked', (table) => {
        table.int('M').primaryKey();
      });
    await driver()
      .insert()
      .into('in_operator')
      .values([{ N: 1 }, { N: 2 }, { N: 3 }]);
    await driver()
      .insert()
      .into('in_operator_picked')
      .values([{ M: 2 }, { M: 3 }]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('in returns the listed rows', async () => {
    expect(await numbers(rows().where('N', 'in', [1, 3]))).to.deep.eq([1, 3]);
  });

  it('not in returns the other rows', async () => {
    expect(await numbers(rows().where('N', 'not in', [1, 3]))).to.deep.eq([2]);
  });

  it('or-connects the list with orWhere()', async () => {
    expect(await numbers(rows().where('N', 1).orWhere('N', 'in', [3]))).to.deep.eq([1, 3]);
  });

  it('takes a sub-query', async () => {
    expect(await numbers(rows().where('N', 'in', driver().select().select('M').from('in_operator_picked')))).to.deep.eq([2, 3]);
  });
});
