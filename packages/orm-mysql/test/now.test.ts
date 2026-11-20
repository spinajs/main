import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';

import { MySqlOrmDriver } from '../src/index.js';

describe('mysql database now', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('is UTC_TIMESTAMP(3) in a UTC connection, usable as a where value', async () => {
    const driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-now-test', Driver: 'orm-driver-mysql', TimeZone: 'UTC' } as any]);
    const out = driver.select().from('t').where('At', '<=', driver.now()).toDB();

    expect(driver.now().Query).to.eq('UTC_TIMESTAMP(3)');
    expect(out.expression).to.contain('`At` <= UTC_TIMESTAMP(3)');
    expect(out.bindings).to.deep.eq([]);
  });

  it('is the session clock NOW(3) by default, the clock datetimes are written in', async () => {
    const driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-now-system', Driver: 'orm-driver-mysql' } as any]);

    expect(driver.now().Query).to.eq('NOW(3)');
  });
});
