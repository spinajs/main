import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Orm, QueryContext, SqlExpressions } from '@spinajs/orm';
import { DateTime } from 'luxon';

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

  it('ago() is the current instant less the amount, in the text format of now()', () => {
    expect(driver().Container.resolve(SqlExpressions).ago(7, 'day')).to.eq("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days'))");
    expect(driver().ago(30, 'second').Query).to.eq("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 seconds'))");
    expect(driver().ago(5, 'minute').Query).to.eq("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes'))");
    expect(driver().ago(0, 'hour').Query).to.eq("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-0 hours'))");
  });

  it('ago() matches a row older than the cutoff and not a newer one', async () => {
    await driver()
      .schema()
      .createTable('ago_rows', (table) => {
        table.string('Name', 16);
        table.dateTime('CreatedAt');
      });
    await driver()
      .insert()
      .into('ago_rows')
      .values([
        { Name: 'old', CreatedAt: DateTime.utc().minus({ days: 7, minutes: 1 }).toISO() },
        { Name: 'new', CreatedAt: DateTime.utc().minus({ days: 6, hours: 23 }).toISO() },
      ]);

    const rows = await driver().select().from('ago_rows').where('CreatedAt', '<', driver().ago(7, 'day')).asRaw<Array<{ Name: string }>>();
    expect(rows.map((r) => r.Name)).to.deep.eq(['old']);
  });

  it('ago() refuses an amount that is not a non-negative integer', () => {
    for (const amount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
      expect(() => driver().ago(amount, 'day')).to.throw(InvalidArgument, 'ago(): amount must be a non-negative integer');
    }
    expect(() => driver().ago(1, 'week' as never)).to.throw(InvalidArgument, 'ago(): unit must be one of second, minute, hour, day');
  });

  it('SqlExpressions.ago() validates for a direct caller', () => {
    expect(() => driver().Container.resolve(SqlExpressions).ago(-1, 'day')).to.throw(InvalidArgument, 'ago(): amount must be a non-negative integer');
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
