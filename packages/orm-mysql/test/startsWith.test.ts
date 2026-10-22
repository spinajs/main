/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { MySqlOrmDriver } from '../src/index.js';

describe('mysql whereStartsWith', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('compiles to LIKE with ESCAPE, leaving a backslash literal', async () => {
    const driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-starts-test', Driver: 'orm-driver-mysql' } as any]);
    const result = driver.select().from('t').whereStartsWith('path', 'a\\b_/').toDB();

    expect(result.expression).to.contain("`path` LIKE ? ESCAPE '~'");
    expect(result.bindings).to.deep.eq(['a\\b~_/%']);
  });
});
