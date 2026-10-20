import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import '@spinajs/log';
import { expect } from 'chai';
import 'mocha';

import { SqliteOrmDriver } from '../src/index.js';

describe('sqlite tableInfo of a missing table', function () {
  this.timeout(15000);

  let driver: SqliteOrmDriver;

  before(async () => {
    driver = await DI.child().resolve(SqliteOrmDriver, [{ Name: 'missing-table', Driver: 'orm-driver-sqlite', Filename: ':memory:' }]);
    await driver.connect();
    await driver.executeOnDb('CREATE TABLE present_t (Id INTEGER PRIMARY KEY, Name TEXT)', [], QueryContext.Schema);
  });

  after(async () => {
    await driver?.disconnect();
  });

  it('answers null for a table that does not exist', async () => {
    expect(await driver.tableInfo('no_such_table')).to.equal(null);
  });

  it('answers the columns of a table that exists', async () => {
    expect((await driver.tableInfo('present_t')).map((c) => c.Name)).to.deep.equal(['Id', 'Name']);
  });
});
