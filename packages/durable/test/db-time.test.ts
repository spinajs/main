import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { defaultSqlDriver, SqlDbTimeSource } from '../src/index.js';
import { bootDb } from './support/env.js';

describe('database time', () => {
  after(() => DI.dispose());

  it('reads sqlite time in epoch milliseconds', async () => {
    await bootDb();
    const ms = await DI.resolve(SqlDbTimeSource).read();
    expect(Math.abs(ms - Date.now())).to.be.lessThan(5000);
  });

  it('reads the time through a driver registered under any name', async () => {
    DI.register(SqliteOrmDriver).as('orm-driver-custom-sqlite');
    await bootDb([{ Driver: 'orm-driver-custom-sqlite', Filename: ':memory:', Name: 'default' }]);
    const ms = await DI.resolve(SqlDbTimeSource).read();
    expect(Math.abs(ms - Date.now())).to.be.lessThan(5000);
  });

  it('finds the default connection', async () => {
    const driver = await bootDb();
    expect(await defaultSqlDriver()).to.eq(driver);
  });
});
