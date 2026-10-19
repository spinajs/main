/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { PostgresOrmDriver } from '../src/index.js';

describe('postgres supported features', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('declares the wire protocol bound-parameter limit', async () => {
    const driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'pg-features-test', Driver: 'orm-driver-postgres' } as any]);

    expect(driver.supportedFeatures().maxBindParameters).to.eq(65535);
    expect(driver.supportedFeatures().maxInsertRows).to.eq(undefined);
  });

  it('allows concurrent transactions', async () => {
    const driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'pg-features-test', Driver: 'orm-driver-postgres' } as any]);

    expect(driver.supportedFeatures().concurrentTransactions).to.eq(true);
  });
});
