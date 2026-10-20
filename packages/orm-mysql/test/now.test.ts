import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { ICompilerOutput } from '@spinajs/orm';

import { MySqlOrmDriver } from '../src/index.js';

describe('mysql database now', function () {
  this.timeout(15000);

  let driver: MySqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-now-test', Driver: 'orm-driver-mysql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('is UTC_TIMESTAMP(3), usable as a where value', () => {
    const out = driver.select().from('t').where('At', '<=', driver.now()).toDB() as ICompilerOutput;

    expect(driver.now().Query).to.eq('UTC_TIMESTAMP(3)');
    expect(out.expression).to.contain('`At` <= UTC_TIMESTAMP(3)');
    expect(out.bindings).to.deep.eq([]);
  });
});
