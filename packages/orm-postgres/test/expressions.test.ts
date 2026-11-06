/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { QueryContext, SqlExpressions } from '@spinajs/orm';

import { PostgresOrmDriver } from '../src/index.js';

describe('postgres sql expressions', function () {
  this.timeout(15000);

  let driver: PostgresOrmDriver;
  let expressions: SqlExpressions;

  beforeEach(async () => {
    driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'postgres-expr-test', Driver: 'orm-driver-postgres' } as any]);
    expressions = driver.Container.resolve(SqlExpressions);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('reads epoch milliseconds from clock_timestamp, not the transaction start', () => {
    expect(expressions.epochMillis()).to.eq('CAST(ROUND(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT)');
  });

  it('reads the database time with one select of that expression', async () => {
    const calls: unknown[][] = [];
    driver.executeOnDb = async (...args: unknown[]) => {
      calls.push(args);
      return [{ ms: '1767225600123' }];
    };

    expect(await driver.epochMillis()).to.eq(1767225600123);
    expect(calls).to.deep.eq([['SELECT CAST(ROUND(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) AS ms', [], QueryContext.Select]]);
  });

  it('concatenates with ||', () => {
    expect(expressions.concat('?', '"Name"', '?')).to.eq('? || "Name" || ?');
    expect(expressions.concat('"Name"')).to.eq('"Name"');
  });

  it('locks selected rows after the LIMIT', () => {
    expect(driver.select().from('t').where('Id', 1).take(1).forUpdate().toDB().expression).to.match(/LIMIT .+ FOR UPDATE$/);
    expect(driver.select().from('t').where('Id', 1).forShare().toDB().expression).to.match(/ FOR SHARE$/);
  });

  it('keeps the lock on a clone', () => {
    expect(driver.select().from('t').forUpdate().clone().toDB().expression).to.match(/ FOR UPDATE$/);
  });
});
