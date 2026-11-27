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

  it('compares exactly with both sides cast, so a plain equality on the same column cannot fold it back', () => {
    expect(expressions.equalsExactly('`subject_id`', { sql: '?', bindings: ['ABC'] })).to.deep.eq({ sql: 'CAST(`subject_id` AS BINARY) = CAST(? AS BINARY)', bindings: ['ABC'] });
  });

  it('concatenates with CONCAT', () => {
    expect(expressions.concat('?', '`Name`', '?')).to.eq('CONCAT(?, `Name`, ?)');
    expect(expressions.concat('`Name`')).to.eq('`Name`');
  });

  it('ago() subtracts an INTERVAL from UTC_TIMESTAMP(3), the clock of now(), by default', () => {
    expect(driver.now().Query).to.eq('UTC_TIMESTAMP(3)');
    expect(expressions.ago(7, 'day')).to.eq('(UTC_TIMESTAMP(3) - INTERVAL 7 DAY)');
    expect(driver.ago(30, 'second').Query).to.eq('(UTC_TIMESTAMP(3) - INTERVAL 30 SECOND)');
  });

  it("ago() subtracts an INTERVAL from NOW(3), the session clock of now(), with TimeZone: 'SYSTEM'", async () => {
    const system = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-expr-system', Driver: 'orm-driver-mysql', TimeZone: 'SYSTEM' } as any]);

    expect(system.now().Query).to.eq('NOW(3)');
    expect(system.Container.resolve(SqlExpressions).ago(7, 'day')).to.eq('(NOW(3) - INTERVAL 7 DAY)');
    expect(system.ago(30, 'second').Query).to.eq('(NOW(3) - INTERVAL 30 SECOND)');
  });

  it('ago() subtracts an INTERVAL from UTC_TIMESTAMP(3), the clock of now(), in a UTC connection', async () => {
    const utc = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-expr-utc', Driver: 'orm-driver-mysql', TimeZone: 'UTC' } as any]);

    expect(utc.now().Query).to.eq('UTC_TIMESTAMP(3)');
    expect(utc.Container.resolve(SqlExpressions).ago(7, 'day')).to.eq('(UTC_TIMESTAMP(3) - INTERVAL 7 DAY)');
    expect(utc.ago(30, 'second').Query).to.eq('(UTC_TIMESTAMP(3) - INTERVAL 30 SECOND)');
    expect(utc.ago(5, 'minute').Query).to.eq('(UTC_TIMESTAMP(3) - INTERVAL 5 MINUTE)');
    expect(utc.ago(2, 'hour').Query).to.eq('(UTC_TIMESTAMP(3) - INTERVAL 2 HOUR)');
  });

  it('reads epoch milliseconds from UTC_TIMESTAMP in a session that is not UTC too', async () => {
    const offset = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-expr-offset', Driver: 'orm-driver-mysql', TimeZone: '+02:00' } as any]);

    expect(offset.Container.resolve(SqlExpressions).epochMillis()).to.eq("TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000");
    expect(offset.ago(1, 'day').Query).to.eq('(NOW(3) - INTERVAL 1 DAY)');
  });

  it('locks selected rows after the LIMIT', () => {
    expect(driver.select().from('t').where('Id', 1).take(1).forUpdate().toDB().expression).to.match(/LIMIT .+ FOR UPDATE$/);
    expect(driver.select().from('t').where('Id', 1).forShare().toDB().expression).to.match(/ LOCK IN SHARE MODE$/);
  });

  it('keeps the lock on a clone', () => {
    expect(driver.select().from('t').forUpdate().clone().toDB().expression).to.match(/ FOR UPDATE$/);
  });
});
