/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ICompilerOutput, Wrapper, outer } from '@spinajs/orm';
import { MySqlOrmDriver } from '../src/index.js';

describe('mysql whereColumn', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('compares a sub-query column with the outer query through its alias', async () => {
    const driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-cc-test', Driver: 'orm-driver-mysql' } as any]);
    const sub = driver.select().from('c', 'c').whereColumn('ParentRef', '=', outer(Wrapper.Text('Id')));
    expect((driver.select().from('p', 'p').whereExist(sub).toDB() as ICompilerOutput).expression).to.contain('EXISTS ( SELECT * FROM `c` as `c` WHERE `c`.`ParentRef` = CAST(`p`.`Id` AS CHAR) )');
  });
});
