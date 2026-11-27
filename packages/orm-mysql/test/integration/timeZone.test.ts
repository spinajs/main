/**
 * The `TimeZone` connection option against a live MySQL, in the zone of this process. Run it in more than one:
 *
 *   TZ=Europe/Warsaw npx ts-mocha -p tsconfig.json test/integration/timeZone.test.ts
 *   TZ=UTC npx ts-mocha -p tsconfig.json test/integration/timeZone.test.ts
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README). The test database is named
 * `<ORM_TEST_MYSQL_DATABASE_PREFIX><random>`, `orm_tz_` by default, and dropped afterwards.
 */
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import '@spinajs/log';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { MySqlOrmDriver } from '../../src/index.js';

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};

const PROCESS_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

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

describe(`mysql TimeZone option, process in ${PROCESS_ZONE} (integration)`, function () {
  this.timeout(60000);

  const database = `${process.env.ORM_TEST_MYSQL_DATABASE_PREFIX ?? 'orm_tz_'}${randomUUID().slice(0, 8)}`;
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

  describe('without TimeZone', () => {
    it('sets the session zone of pooled and dedicated connections to UTC', async () => {
      const driver = await open();
      const dedicated = await driver.openDedicatedConnection();

      try {
        expect((await one<{ z: string }>(driver, 'SELECT @@session.time_zone AS z')).z).to.eq('+00:00');
        const [rows] = await dedicated.query('SELECT @@session.time_zone AS z');
        expect(rows).to.have.nested.property('[0].z', '+00:00');
      } finally {
        await dedicated.end();
      }
    });

    it('stores an instant as the UTC wall clock and another connection reads the same instant', async () => {
      const writer = await open();
      const reader = await open();

      await writer.insert().into('tz_t').values({ Id: 1, At: AT });

      expect((await one<{ t: string }>(reader, 'SELECT CAST(At AS CHAR) AS t FROM tz_t WHERE Id = 1')).t).to.eq('2026-09-30 22:00:00.000');
      expect((await one<{ At: Date }>(reader, 'SELECT At FROM tz_t WHERE Id = 1')).At.toISOString()).to.eq(AT.toISOString());
    });

    it('reads a row 3.0.29 wrote, the UTC wall clock, as the same instant in winter and in summer', async () => {
      const driver = await open();

      await driver.executeOnDb("INSERT INTO tz_t (Id, At) VALUES (2, '2030-01-15 12:00:00.000'), (3, '2030-07-15 12:00:00.000')", [], QueryContext.Insert);

      expect((await one<{ At: Date }>(driver, 'SELECT At FROM tz_t WHERE Id = 2')).At.toISOString()).to.eq('2030-01-15T12:00:00.000Z');
      expect((await one<{ At: Date }>(driver, 'SELECT At FROM tz_t WHERE Id = 3')).At.toISOString()).to.eq('2030-07-15T12:00:00.000Z');
    });

    it('compares a bound instant with now() on the same clock', async () => {
      const driver = await open();

      const drift = await one<{ s: number }>(driver, `SELECT ABS(TIMESTAMPDIFF(SECOND, ?, ${driver.now().Query})) AS s`, [new Date()]);
      expect(Number(drift.s)).to.be.lessThan(5);
    });
  });

  describe("with TimeZone: 'SYSTEM'", () => {
    it("keeps the server's session zone", async () => {
      const driver = await open('SYSTEM');
      const row = await one<{ session: string; global: string }>(driver, 'SELECT @@session.time_zone AS session, @@global.time_zone AS global');

      expect(row.session).to.eq(row.global);
    });

    it('stores an instant as the wall clock of this process and reads it back', async () => {
      const driver = await open('SYSTEM');

      await driver.insert().into('tz_t').values({ Id: 4, At: AT });

      expect((await one<{ t: string }>(driver, 'SELECT CAST(At AS CHAR) AS t FROM tz_t WHERE Id = 4')).t).to.eq(DateTime.fromJSDate(AT).toFormat('yyyy-MM-dd HH:mm:ss.SSS'));
      expect((await one<{ At: Date }>(driver, 'SELECT At FROM tz_t WHERE Id = 4')).At.toISOString()).to.eq(AT.toISOString());
    });
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

    await driver.insert().into('tz_t').values({ Id: 10, At: AT });

    expect((await one<{ t: string }>(driver, 'SELECT CAST(At AS CHAR) AS t FROM tz_t WHERE Id = 10')).t).to.eq('2026-10-01 00:00:00.000');
    expect((await one<{ At: Date }>(driver, 'SELECT At FROM tz_t WHERE Id = 10')).At.getTime()).to.eq(AT.getTime());

    const drift = await one<{ s: number }>(driver, `SELECT ABS(TIMESTAMPDIFF(SECOND, ?, ${driver.now().Query})) AS s`, [new Date()]);
    expect(Number(drift.s)).to.be.lessThan(5);
  });
});
