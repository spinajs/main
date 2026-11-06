/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { NotSupported } from '@spinajs/exceptions';
import { SqlExpressions } from '@spinajs/orm';

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

  it('concatenates with CONCAT, which needs two arguments', () => {
    expect(expressions.concat('?', '[Name]', '?')).to.eq('CONCAT(?, [Name], ?)');
    expect(expressions.concat('[Name]')).to.eq('[Name]');
  });

  it('refuses a row lock: MSSQL takes it as a table hint', () => {
    expect(() => driver.select().from('t').forUpdate().toDB()).to.throw(NotSupported);
  });
});
