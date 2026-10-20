/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ICompilerOutput } from '@spinajs/orm';
import { MsSqlOrmDriver } from '../src/index.js';

describe('mssql selectCondition()', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('compiles a CASE column, which T-SQL needs for a predicate in a select list', async () => {
    const driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-sc-test', Driver: 'orm-driver-mssql' } as any]);
    const out = driver
      .select()
      .from('t')
      .selectCondition('isA', function () {
        this.where('Flag', 'a');
      })
      .toDB() as ICompilerOutput;
    expect(out.expression).to.contain('CASE WHEN [Flag] = ? THEN 1 ELSE 0 END AS [isA]');
  });
});
