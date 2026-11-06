/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { NotSupported } from '@spinajs/exceptions';
import { QueryContext, SqlExpressions } from '@spinajs/orm';

import { MsSqlOrmDriver } from '../src/index.js';

describe('mssql sql expressions', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;
  let expressions: SqlExpressions;

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-expr-test', Driver: 'orm-driver-mssql' } as any]);
    expressions = driver.Container.resolve(SqlExpressions);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('reads epoch milliseconds from SYSUTCDATETIME', () => {
    expect(expressions.epochMillis()).to.eq("DATEDIFF_BIG(MILLISECOND, '19700101', SYSUTCDATETIME())");
  });

  it('reads the database time with one select of that expression', async () => {
    const calls: unknown[][] = [];
    driver.executeOnDb = async (...args: unknown[]) => {
      calls.push(args);
      return [{ ms: '1767225600123' }];
    };

    expect(await driver.epochMillis()).to.eq(1767225600123);
    expect(calls).to.deep.eq([["SELECT DATEDIFF_BIG(MILLISECOND, '19700101', SYSUTCDATETIME()) AS ms", [], QueryContext.Select]]);
  });

  it('concatenates with CONCAT, which needs two arguments', () => {
    expect(expressions.concat('?', '[Name]', '?')).to.eq('CONCAT(?, [Name], ?)');
    expect(expressions.concat('[Name]')).to.eq('[Name]');
  });

  it('ago() is a DATEADD on SYSDATETIMEOFFSET(), the clock of now()', () => {
    expect(expressions.ago(7, 'day')).to.eq('(DATEADD(day, -7, SYSDATETIMEOFFSET()))');
    expect(driver.ago(30, 'second').Query).to.eq('(DATEADD(second, -30, SYSDATETIMEOFFSET()))');
    expect(driver.ago(5, 'minute').Query).to.eq('(DATEADD(minute, -5, SYSDATETIMEOFFSET()))');
    expect(driver.ago(2, 'hour').Query).to.eq('(DATEADD(hour, -2, SYSDATETIMEOFFSET()))');
  });

  it('refuses a row lock: MSSQL takes it as a table hint', () => {
    expect(() => driver.select().from('t').forUpdate().toDB()).to.throw(NotSupported);
  });
});
