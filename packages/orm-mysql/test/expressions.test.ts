/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { SqlExpressions } from '@spinajs/orm';

import { MySqlOrmDriver } from '../src/index.js';

describe('mysql sql expressions', function () {
  this.timeout(15000);

  let expressions: SqlExpressions;

  beforeEach(async () => {
    const driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-expr-test', Driver: 'orm-driver-mysql' } as any]);
    expressions = driver.Container.resolve(SqlExpressions);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('reads epoch milliseconds from UTC_TIMESTAMP, whatever the session zone', () => {
    expect(expressions.epochMillis()).to.eq("TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000");
  });

  it('concatenates with CONCAT', () => {
    expect(expressions.concat('?', '`Name`', '?')).to.eq('CONCAT(?, `Name`, ?)');
    expect(expressions.concat('`Name`')).to.eq('`Name`');
  });
});
