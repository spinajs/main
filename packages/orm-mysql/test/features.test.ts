/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { MySqlOrmDriver } from '../src/index.js';

describe('mysql supported features', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('declares the prepared-statement bound-parameter limit', async () => {
    const driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-features-test', Driver: 'orm-driver-mysql' } as any]);

    expect(driver.MaxBindings).to.eq(65535);
    expect(driver.MaxInsertRows).to.eq(Infinity);
  });

  it('allows concurrent transactions', async () => {
    const driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-features-test', Driver: 'orm-driver-mysql' } as any]);

    expect(driver.supportedFeatures().concurrentTransactions).to.eq(true);
  });
});
