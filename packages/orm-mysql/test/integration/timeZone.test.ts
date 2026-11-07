/**
 * The `TimeZone` connection option against a live MySQL.
 *
 *   npx ts-mocha -p tsconfig.json test/integration/timeZone.test.ts
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

// 2026-10-01 00:00 at +02:00
const AT = new Date(Date.UTC(2026, 8, 30, 22, 0, 0, 0));

async function driverOn(database: string, timeZone?: string): Promise<MySqlOrmDriver> {
  const options = { Name: `tz-${database}-${timeZone ?? 'default'}`, Driver: 'orm-driver-mysql', ...SERVER, Database: database, ...(timeZone ? { TimeZone: timeZone } : {}) };
  const driver = await DI.child().resolve(MySqlOrmDriver, [options]);
  await driver.connect();
  return driver;
}

async function one<T>(driver: MySqlOrmDriver, sql: string, params: unknown[] = []): Promise<T> {
  const rows = (await driver.executeOnDb(sql, params, QueryContext.Select)) as T[];
  return rows[0];
}

describe('mysql TimeZone option (integration)', function () {
  this.timeout(60000);

  const database = `orm_tz_${randomUUID().slice(0, 8)}`;
  const opened: MySqlOrmDriver[] = [];
  let admin: MySqlOrmDriver;

  async function open(timeZone?: string) {
    const driver = await driverOn(database, timeZone);
    opened.push(driver);
    return driver;
  }

  before(async () => {
    admin = await driverOn('mysql');
    await admin.schema().createDatabase(database);
    const driver = await open('UTC');
    await driver.executeOnDb('CREATE TABLE tz_t (Id INT PRIMARY KEY, At DATETIME(3))', [], QueryContext.Schema);
  });

  after(async () => {
    for (const driver of opened) {
      await driver.disconnect();
    }
    await admin?.executeOnDb(`DROP DATABASE IF EXISTS \`${database}\``, [], QueryContext.Schema);
    await admin?.disconnect();
  });

  it("keeps the server's session zone by default", async () => {
    const driver = await open();
    const row = await one<{ session: string; global: string }>(driver, 'SELECT @@session.time_zone AS session, @@global.time_zone AS global');

    expect(row.session).to.eq(row.global);
  });

  it('sets the session zone to UTC', async () => {
    const driver = await open('UTC');

    expect((await one<{ z: string }>(driver, 'SELECT @@session.time_zone AS z')).z).to.eq('+00:00');
    expect((await one<{ d: string }>(driver, 'SELECT CAST(DATE(FROM_UNIXTIME(?)) AS CHAR) AS d', [AT.getTime() / 1000])).d).to.eq('2026-09-30');
  });

  it('computes dates in SQL, stores, reads back and compares with now() in a fixed offset zone', async () => {
    const driver = await open('+02:00');

    expect((await one<{ z: string }>(driver, 'SELECT @@session.time_zone AS z')).z).to.eq('+02:00');
    expect((await one<{ d: string }>(driver, 'SELECT CAST(DATE(FROM_UNIXTIME(?)) AS CHAR) AS d', [AT.getTime() / 1000])).d).to.eq('2026-10-01');

    await driver.insert().into('tz_t').values({ Id: 1, At: AT });

    expect((await one<{ t: string }>(driver, 'SELECT CAST(At AS CHAR) AS t FROM tz_t WHERE Id = 1')).t).to.eq('2026-10-01 00:00:00.000');
    expect((await one<{ At: Date }>(driver, 'SELECT At FROM tz_t WHERE Id = 1')).At.getTime()).to.eq(AT.getTime());

    const drift = await one<{ s: number }>(driver, `SELECT ABS(TIMESTAMPDIFF(SECOND, ?, ${driver.now().Query})) AS s`, [new Date()]);
    expect(Number(drift.s)).to.be.lessThan(5);
  });
});
