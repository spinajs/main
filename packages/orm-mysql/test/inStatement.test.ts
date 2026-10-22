/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { MySqlOrmDriver } from '../src/index.js';

describe('mysql whereIn', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('keeps a long list expanded: mysql2 binds client-side', async () => {
    const driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-in-test', Driver: 'orm-driver-mysql' } as any]);
    const result = driver
      .select()
      .from('t')
      .whereIn(
        'id',
        Array.from({ length: 5000 }, (_, i) => i),
      )
      .toDB();

    expect(result.expression).to.contain('`id` IN (?,?,');
    expect(result.bindings).to.have.length(5000);
  });
});
