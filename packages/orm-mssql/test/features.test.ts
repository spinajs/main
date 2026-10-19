/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { MsSqlOrmDriver } from '../src/index.js';

describe('mssql supported features', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-features-test', Driver: 'orm-driver-mssql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('declares SQL Server parameter and VALUES row limits', () => {
    expect(driver.supportedFeatures().maxBindParameters).to.eq(2098);
    expect(driver.supportedFeatures().maxInsertRows).to.eq(1000);
  });

  it('splits a one-column insert at 1000 rows', () => {
    const insert = driver
      .insert()
      .into('t')
      .values(Array.from({ length: 2500 }, (_, i) => ({ id: i })));

    expect(insert.splitByDriverLimits().map((c) => c.Values.length)).to.deep.eq([1000, 1000, 500]);
  });

  it('splits a three-column insert at 699 rows', () => {
    const insert = driver
      .insert()
      .into('t')
      .values(Array.from({ length: 1500 }, (_, i) => ({ a: i, b: i, c: i })));

    expect(insert.splitByDriverLimits().map((c) => c.Values.length)).to.deep.eq([699, 699, 102]);
  });

  it('allows concurrent transactions', () => {
    expect(driver.supportedFeatures().concurrentTransactions).to.eq(true);
  });
});
