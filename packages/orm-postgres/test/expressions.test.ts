/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { SqlExpressions } from '@spinajs/orm';

import { PostgresOrmDriver } from '../src/index.js';

describe('postgres sql expressions', function () {
  this.timeout(15000);

  let expressions: SqlExpressions;

  beforeEach(async () => {
    const driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'postgres-expr-test', Driver: 'orm-driver-postgres' } as any]);
    expressions = driver.Container.resolve(SqlExpressions);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('reads epoch milliseconds from clock_timestamp, not the transaction start', () => {
    expect(expressions.epochMillis()).to.eq('CAST(ROUND(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT)');
  });

  it('concatenates with ||', () => {
    expect(expressions.concat('?', '"Name"', '?')).to.eq('? || "Name" || ?');
    expect(expressions.concat('"Name"')).to.eq('"Name"');
  });
});
