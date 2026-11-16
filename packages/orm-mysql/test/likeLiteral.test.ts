import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { LikeLiteral } from '@spinajs/orm';
import { MySqlOrmDriver } from '../src/index.js';

describe('mysql LikeLiteral', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('compiles to LIKE with ESCAPE, leaving a backslash literal', async () => {
    const driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-like-test', Driver: 'orm-driver-mysql' } as any]);
    const result = driver.select().from('t').where('name', 'like', LikeLiteral.contains('a\\b_%')).toDB();

    expect(result.expression).to.contain("`name` LIKE ? ESCAPE '~'");
    expect(result.bindings).to.deep.eq(['%a\\b~_~%%']);
  });
});
