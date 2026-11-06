import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, QueryContext, SqlExpressions } from '@spinajs/orm';

import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

describe('sqlite sql expressions', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('reads the current time in epoch milliseconds', async () => {
    const sql = driver().Container.resolve(SqlExpressions).epochMillis();
    const [row] = (await driver().executeOnDb(`SELECT ${sql} AS ms`, [], QueryContext.Select)) as Array<{ ms: number }>;

    expect(Math.abs(Number(row.ms) - Date.now())).to.be.lessThan(5000);
  });

  it('reads the database time through the driver, inside a transaction too', async () => {
    expect(Math.abs((await driver().epochMillis()) - Date.now())).to.be.lessThan(5000);

    const inTransaction = await driver().transaction(async (d) => d.epochMillis());
    expect(Math.abs(inTransaction - Date.now())).to.be.lessThan(5000);
  });

  it('concatenates with ||', async () => {
    const sql = driver().Container.resolve(SqlExpressions).concat('?', "'b'", '?');
    const [row] = (await driver().executeOnDb(`SELECT ${sql} AS v`, ['a', 'c'], QueryContext.Select)) as Array<{ v: string }>;

    expect(sql).to.eq("? || 'b' || ?");
    expect(row.v).to.eq('abc');
  });

  it('adds no clause for a row lock: a write transaction locks the whole database', () => {
    const plain = driver().select().from('t').where('Id', 1).toDB().expression;
    expect(driver().select().from('t').where('Id', 1).forUpdate().toDB().expression).to.eq(plain);
  });

  it('refuses a row lock on a recursive CTE query instead of dropping it', () => {
    const query = driver().select().withRecursive('parent_id', 'id').from('t').forUpdate();
    expect(() => query.toDB()).to.throw('row locks are not supported on a recursive CTE query');
  });
});
