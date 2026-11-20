/**
 * `LikeLiteral` against a live MySQL, whose LIKE escapes with a backslash unless told otherwise.
 *
 *   npx ts-mocha -p tsconfig.json test/integration/likeLiteral.test.ts
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README).
 */
import { DI } from '@spinajs/di';
import { LikeLiteral, QueryContext } from '@spinajs/orm';
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

const NAMES = ['100%', '1000', 'a_b', 'axb', 'b\\s', 'bxs', '~t', 'xt', 'docs[1]', 'docs1', 'Plain'];

const CASES: [LikeLiteral, string[]][] = [
  [LikeLiteral.contains('%'), ['100%']],
  [LikeLiteral.contains('_'), ['a_b']],
  [LikeLiteral.contains('\\'), ['b\\s']],
  [LikeLiteral.contains('b\\s'), ['b\\s']],
  [LikeLiteral.contains('~'), ['~t']],
  [LikeLiteral.contains('[1]'), ['docs[1]']],
  [LikeLiteral.contains('plain'), ['Plain']],
  [LikeLiteral.startsWith('a_'), ['a_b']],
  [LikeLiteral.endsWith('0%'), ['100%']],
];

async function driverOn(database: string): Promise<MySqlOrmDriver> {
  const driver = await DI.child().resolve(MySqlOrmDriver, [{ Name: `like-${database}`, Driver: 'orm-driver-mysql', ...SERVER, Database: database }]);
  await driver.connect();
  return driver;
}

describe('mysql LikeLiteral (integration)', function () {
  this.timeout(60000);

  const database = `orm_like_${randomUUID().slice(0, 8)}`;
  let admin: MySqlOrmDriver;
  let driver: MySqlOrmDriver;

  before(async () => {
    admin = await driverOn('mysql');
    await admin.schema().createDatabase(database);
    driver = await driverOn(database);
    await driver.executeOnDb('CREATE TABLE like_t (Id INT PRIMARY KEY, Name VARCHAR(64))', [], QueryContext.Schema);
    await driver
      .insert()
      .into('like_t')
      .values([...NAMES.map((Name, Id) => ({ Id, Name })), { Id: 99, Name: null }]);
  });

  after(async () => {
    await driver?.disconnect();
    await admin?.executeOnDb(`DROP DATABASE IF EXISTS \`${database}\``, [], QueryContext.Schema);
    await admin?.disconnect();
  });

  for (const [literal, expected] of CASES) {
    it(`${literal.Match} ${JSON.stringify(literal.Text)} matches literally, case as LIKE does`, async () => {
      const rows = await driver.select().select('Name').from('like_t').where('Name', 'like', literal).asRaw<{ Name: string }[]>();

      expect(rows.map((r) => r.Name).sort()).to.deep.eq(expected);
    });
  }
});
