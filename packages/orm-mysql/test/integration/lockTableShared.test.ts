/**
 * `lockTableShared()` against a live MySQL: writers from another session wait until the
 * locking transaction ends, while plain reads go on.
 *
 *   docker compose --profile test up -d mysql
 *   npx ts-mocha -p tsconfig.json test/integration/lockTableShared.test.ts
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README).
 */
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import '@spinajs/log';
import { expect } from 'chai';
import 'mocha';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';

import { MySqlOrmDriver } from '../../src/index.js';

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};

async function driverOn(database: string): Promise<MySqlOrmDriver> {
  const driver = await DI.child().resolve(MySqlOrmDriver, [{ Name: `lock-${database}`, Driver: 'orm-driver-mysql', ...SERVER, Database: database }]);
  await driver.connect();
  return driver;
}

describe('mysql lockTableShared (integration)', function () {
  this.timeout(60000);

  const database = `orm_lock_${randomUUID().slice(0, 8)}`;
  let admin: MySqlOrmDriver;
  let driver: MySqlOrmDriver;

  before(async () => {
    admin = await driverOn('mysql');
    await admin.schema().createDatabase(database);
    driver = await driverOn(database);

    // Role is indexed, so COUNT(*) may scan that index instead of the clustered one; Name is not.
    await driver.executeOnDb('CREATE TABLE lock_t (Id INT PRIMARY KEY, Role VARCHAR(64) NOT NULL, Name VARCHAR(64) NOT NULL, INDEX lock_t_role (Role))', [], QueryContext.Schema);
    await driver.executeOnDb(`INSERT INTO lock_t (Id, Role, Name) VALUES (1, 'admin', 'a'), (2, 'user', 'b')`, [], QueryContext.Insert);
  });

  after(async () => {
    await driver?.disconnect();
    await admin?.executeOnDb(`DROP DATABASE IF EXISTS \`${database}\``, [], QueryContext.Schema);
    await admin?.disconnect();
  });

  /** Another session that gives up on a row lock after one second instead of waiting. */
  async function otherSession(): Promise<mysql.Connection> {
    const connection = await mysql.createConnection({ host: SERVER.Host, port: SERVER.Port, user: SERVER.User, password: SERVER.Password, database });
    await connection.query('SET SESSION innodb_lock_wait_timeout = 1');
    return connection;
  }

  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'done',
      (e: { code?: string }) => e.code,
    );

  it('keeps updates of unindexed columns, inserts and deletes out until the transaction ends; plain reads go on', async () => {
    const other = await otherSession();

    try {
      await driver.transaction(async () => {
        await driver.lockTableShared('lock_t');

        const [rows] = await other.query('SELECT COUNT(*) AS n FROM lock_t');
        expect((rows as { n: number }[])[0].n).to.eq(2);

        expect(await outcome(other.query(`UPDATE lock_t SET Name = 'x' WHERE Id = 1`))).to.eq('ER_LOCK_WAIT_TIMEOUT');
        expect(await outcome(other.query(`INSERT INTO lock_t (Id, Role, Name) VALUES (3, 'z', 'c')`))).to.eq('ER_LOCK_WAIT_TIMEOUT');
        expect(await outcome(other.query('DELETE FROM lock_t WHERE Id = 2'))).to.eq('ER_LOCK_WAIT_TIMEOUT');
      });

      expect(await outcome(other.query(`UPDATE lock_t SET Name = 'x' WHERE Id = 1`))).to.eq('done');
    } finally {
      await other.end();
    }
  });
});
