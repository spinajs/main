/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { QueryContext, SqlExpressions } from '@spinajs/orm';

import { MySqlOrmDriver } from '../src/index.js';

describe('mysql sql expressions', function () {
  this.timeout(15000);

  let driver: MySqlOrmDriver;
  let expressions: SqlExpressions;

  beforeEach(async () => {
    driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-expr-test', Driver: 'orm-driver-mysql' } as any]);
    expressions = driver.Container.resolve(SqlExpressions);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('reads epoch milliseconds from UTC_TIMESTAMP, whatever the session zone', () => {
    expect(expressions.epochMillis()).to.eq("TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000");
  });

  it('reads the database time with one select of that expression', async () => {
    const calls: unknown[][] = [];
    driver.executeOnDb = async (...args: unknown[]) => {
      calls.push(args);
      return [{ ms: '1767225600123' }];
    };

    expect(await driver.epochMillis()).to.eq(1767225600123);
    expect(calls).to.deep.eq([["SELECT TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000 AS ms", [], QueryContext.Select]]);
  });

  it('concatenates with CONCAT', () => {
    expect(expressions.concat('?', '`Name`', '?')).to.eq('CONCAT(?, `Name`, ?)');
    expect(expressions.concat('`Name`')).to.eq('`Name`');
  });

  it('ago() subtracts an INTERVAL from UTC_TIMESTAMP(3), the clock of now()', () => {
    expect(expressions.ago(7, 'day')).to.eq('(UTC_TIMESTAMP(3) - INTERVAL 7 DAY)');
    expect(driver.ago(30, 'second').Query).to.eq('(UTC_TIMESTAMP(3) - INTERVAL 30 SECOND)');
    expect(driver.ago(5, 'minute').Query).to.eq('(UTC_TIMESTAMP(3) - INTERVAL 5 MINUTE)');
    expect(driver.ago(2, 'hour').Query).to.eq('(UTC_TIMESTAMP(3) - INTERVAL 2 HOUR)');
  });

  it('locks selected rows after the LIMIT', () => {
    expect(driver.select().from('t').where('Id', 1).take(1).forUpdate().toDB().expression).to.match(/LIMIT .+ FOR UPDATE$/);
    expect(driver.select().from('t').where('Id', 1).forShare().toDB().expression).to.match(/ LOCK IN SHARE MODE$/);
  });

  it('keeps the lock on a clone', () => {
    expect(driver.select().from('t').forUpdate().clone().toDB().expression).to.match(/ FOR UPDATE$/);
  });
});
