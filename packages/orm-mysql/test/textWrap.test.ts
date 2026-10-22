/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Wrapper } from '@spinajs/orm';
import { MySqlOrmDriver } from '../src/index.js';

describe('mysql Wrapper.Text', function () {
  this.timeout(15000);

  let driver: MySqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-text-test', Driver: 'orm-driver-mysql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('casts to CHAR in where() and whereIn()', () => {
    expect((driver.select().from('t', 'i').whereIn(Wrapper.Text('Id'), ['1', '2']).toDB()).expression).to.contain('CAST(`i`.`Id` AS CHAR) IN (?,?)');
    expect((driver.select().from('t').where(Wrapper.Text('Id'), '=', '1').toDB()).expression).to.contain('CAST(`Id` AS CHAR) = ?');
  });
});
