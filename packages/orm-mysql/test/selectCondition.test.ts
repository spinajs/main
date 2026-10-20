/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ICompilerOutput } from '@spinajs/orm';
import { MySqlOrmDriver } from '../src/index.js';

describe('mysql selectCondition()', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('compiles a CASE column', async () => {
    const driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-sc-test', Driver: 'orm-driver-mysql' } as any]);
    const out = driver
      .select()
      .from('t')
      .selectCondition('isA', function () {
        this.where('Flag', 'a');
      })
      .toDB() as ICompilerOutput;
    expect(out.expression).to.contain('CASE WHEN `Flag` = ? THEN 1 ELSE 0 END AS `isA`');
    expect(out.bindings).to.deep.eq(['a']);
  });
});
