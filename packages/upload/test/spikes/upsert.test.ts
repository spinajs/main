import 'mocha';
import '@spinajs/orm-sqlite';
import { expect } from 'chai';
import { randomBytes } from 'node:crypto';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

import { bootConfiguration } from '../support/config.js';
import { MYSQL, POSTGRES, connectMysql, connectPostgres, mysqlAdmin, postgresAdmin, requireServer } from '../support/servers.js';

const TABLE = 'spike_parts';

interface PartRow {
  session_id: string;
  number: number;
  size: number;
  sha256: string;
  storage_key: string;
}

async function createPartsTable(driver: OrmDriver): Promise<void> {
  await driver.schema().createTable(TABLE, (table) => {
    table.string('session_id', 36).notNull().primaryKey();
    table.int('number').notNull().primaryKey();
    table.bigint('size').notNull();
    table.string('sha256', 64).notNull();
    table.string('storage_key', 1024).notNull();
  });
}

const upsert = (driver: OrmDriver, row: PartRow) => driver.insert().into(TABLE).values(row).onDuplicate(['session_id', 'number']).update(['size', 'sha256', 'storage_key']);

/** Part 1 sent twice and part 2 once: one row per part, and the resend's values win. */
async function resendReplacesTheRow(driver: OrmDriver): Promise<void> {
  await upsert(driver, { session_id: 's1', number: 1, size: 4, sha256: 'a'.repeat(64), storage_key: 'k1' });
  await upsert(driver, { session_id: 's1', number: 1, size: 4, sha256: 'b'.repeat(64), storage_key: 'k2' });
  await upsert(driver, { session_id: 's1', number: 2, size: 2, sha256: 'c'.repeat(64), storage_key: 'k3' });
  const rows = (await driver.select().from(TABLE).where('session_id', 's1')) as PartRow[];
  const seen = rows.map((r) => [Number(r.number), r.storage_key, r.sha256]).sort((a, b) => Number(a[0]) - Number(b[0]));
  expect(seen).to.deep.equal([
    [1, 'k2', 'b'.repeat(64)],
    [2, 'k3', 'c'.repeat(64)],
  ]);
}

describe('spike §11.3: onDuplicate upsert of (session_id, number)', function () {
  this.timeout(60000);

  describe('on sqlite', () => {
    let driver: OrmDriver;

    before(async () => {
      await bootConfiguration();
      driver = await DI.child().resolve<OrmDriver>(SqliteOrmDriver, [{ Name: 'spike-sqlite', Driver: 'orm-driver-sqlite', Filename: ':memory:' }]);
      await driver.connect();
      await createPartsTable(driver);
    });

    after(async () => {
      await driver?.disconnect();
    });

    it('keeps one row per part and lets a resend replace it', () => resendReplacesTheRow(driver));
  });

  describe('on postgres', () => {
    const database = `upload_upsert_${randomBytes(4).toString('hex')}`;
    let driver: OrmDriver | undefined;

    before(async function () {
      await bootConfiguration();
      await requireServer(this, 'postgres', POSTGRES.Host, POSTGRES.Port);
      await postgresAdmin(`CREATE DATABASE ${database}`);
      driver = await connectPostgres(database);
      await createPartsTable(driver);
    });

    after(async () => {
      if (!driver) return;
      await driver.disconnect();
      await postgresAdmin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    });

    it('keeps one row per part and lets a resend replace it', () => resendReplacesTheRow(driver!));
  });

  describe('on mysql', () => {
    it('compiles to ON DUPLICATE KEY UPDATE with VALUES(), without a server', async () => {
      await bootConfiguration();
      const driver = await DI.child().resolve<OrmDriver>(MySqlOrmDriver, [{ Name: 'spike-mysql-compile', Driver: 'orm-driver-mysql', ...MYSQL, Database: 'test' }]);
      const compiled = upsert(driver, { session_id: 's1', number: 1, size: 4, sha256: 'a'.repeat(64), storage_key: 'k1' }).toDB() as { expression: string };
      expect(compiled.expression).to.match(/ON DUPLICATE KEY UPDATE `size` = VALUES\(`size`\),`sha256` = VALUES\(`sha256`\),`storage_key` = VALUES\(`storage_key`\)/);
    });

    describe('live', () => {
      const database = `upload_upsert_${randomBytes(4).toString('hex')}`;
      let driver: OrmDriver | undefined;

      before(async function () {
        await bootConfiguration();
        await requireServer(this, 'mysql', MYSQL.Host, MYSQL.Port);
        await mysqlAdmin(`CREATE DATABASE ${database}`);
        driver = await connectMysql(database);
        await createPartsTable(driver);
      });

      after(async () => {
        if (!driver) return;
        await driver.disconnect();
        await mysqlAdmin(`DROP DATABASE ${database}`);
      });

      it('keeps one row per part and lets a resend replace it', () => resendReplacesTheRow(driver!));
    });
  });
});
