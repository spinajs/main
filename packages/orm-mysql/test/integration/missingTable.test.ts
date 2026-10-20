/**
 * `tableInfo()` against a live MySQL: a missing table answers null, as on every other driver.
 *
 *   npx ts-mocha -p tsconfig.json test/integration/missingTable.test.ts
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README).
 */
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import '@spinajs/log';
import { expect } from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { MySqlOrmDriver } from '../../src/index.js';

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};

async function driverOn(database: string): Promise<MySqlOrmDriver> {
  const driver = await DI.child().resolve(MySqlOrmDriver, [{ Name: `missing-${database}`, Driver: 'orm-driver-mysql', ...SERVER, Database: database }]);
  await driver.connect();
  return driver;
}

describe('mysql tableInfo of a missing table (integration)', function () {
  this.timeout(60000);

  const database = `orm_missing_${randomUUID().slice(0, 8)}`;
  let admin: MySqlOrmDriver;
  let driver: MySqlOrmDriver;

  before(async () => {
    admin = await driverOn('mysql');
    await admin.schema().createDatabase(database);
    driver = await driverOn(database);
    await driver.executeOnDb('CREATE TABLE present_t (Id INT PRIMARY KEY, Name VARCHAR(64))', [], QueryContext.Schema);
  });

  after(async () => {
    await driver?.disconnect();
    await admin?.executeOnDb(`DROP DATABASE IF EXISTS \`${database}\``, [], QueryContext.Schema);
    await admin?.disconnect();
  });

  it('answers null for a table that does not exist', async () => {
    expect(await driver.tableInfo('no_such_table')).to.equal(null);
  });

  it('answers null for a table of another database that does not exist', async () => {
    expect(await driver.tableInfo('present_t', 'mysql')).to.equal(null);
  });

  it('answers the columns of a table that exists', async () => {
    expect((await driver.tableInfo('present_t')).map((c) => c.Name)).to.deep.equal(['Id', 'Name']);
  });
});
