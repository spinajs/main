/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { MsSqlOrmDriver } from '../src/index.js';

describe('mssql whereNot(group)', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('compiles to NOT ( ... )', async () => {
    const driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-not-test', Driver: 'orm-driver-mssql' } as any]);
    const out = driver
      .select()
      .from('t')
      .whereNot(function () {
        this.where('Flag', 'a');
      })
      .toDB();
    expect(out.expression).to.contain('NOT ( [Flag] = ? )');
  });
});
