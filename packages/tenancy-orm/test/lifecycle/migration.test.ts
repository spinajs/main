import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import type { Class } from '@spinajs/di';
import { RowLease } from '@spinajs/durable';
import type { OrmDriver } from '@spinajs/orm';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';
import { PgliteOrmDriver } from '@spinajs/orm-pglite';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import type { TestApp } from '@spinajs/testing';

import { LIFECYCLE_LEASE_MS, TENANTS_TABLE, Tenants_2026_11_16_00_00_00, Tenants_2026_12_01_00_00_00 } from '../../src/index.js';
import { LIFECYCLE_LEASE_COLUMNS } from '../../src/lifecycle/lease.js';
import { bootRowApp } from './support/app.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const DATABASE = 'v4_tl_02_provision_migrate';

interface Target {
  readonly type: Class<OrmDriver>;
  readonly options: Record<string, unknown>;
  /** A server: the database of the admin connection (`null`: none) and how the test database goes. */
  readonly server?: { readonly admin: string | null; readonly drop: string };
}

// The docker fixtures of the orm-* packages' own tests; never started or stopped here.
const TARGETS: Record<string, Target> = {
  sqlite: { type: SqliteOrmDriver, options: { Driver: 'orm-driver-sqlite', Filename: ':memory:' } },
  pglite: { type: PgliteOrmDriver, options: { Driver: 'orm-driver-pglite' } },
  postgres: {
    type: PostgresOrmDriver,
    options: { Driver: 'orm-driver-postgres', Host: '127.0.0.1', Port: Number(process.env.ORM_TEST_POSTGRES_PORT ?? 15432), User: 'postgres', Password: 'postgres' },
    server: { admin: 'postgres', drop: `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)` },
  },
  mysql: { type: MySqlOrmDriver, options: { Driver: 'orm-driver-mysql', Host: '127.0.0.1', Port: 13306, User: 'root', Password: 'root' }, server: { admin: null, drop: `DROP DATABASE IF EXISTS ${DATABASE}` } },
  mssql: {
    type: MsSqlOrmDriver,
    options: { Driver: 'orm-driver-mssql', Host: '127.0.0.1', User: 'sa', Password: 'yourStrong(!)Password', Options: { TrustServerCertificate: true } },
    server: { admin: 'master', drop: `DROP DATABASE IF EXISTS ${DATABASE}` },
  },
};

async function rowOf(driver: OrmDriver): Promise<Record<string, unknown>> {
  const rows: unknown = await driver.select().from(TENANTS_TABLE).where('id', 'old');
  const first: unknown = Array.isArray(rows) ? rows[0] : undefined;
  if (first === null || typeof first !== 'object') throw new Error('the row of tenant "old" is gone');
  return { ...first };
}

describe('the migration of the lifecycle columns', function () {
  this.timeout(120_000);
  let app: TestApp;

  before(async () => {
    app = await bootRowApp();
  });

  after(async () => {
    await app?.dispose();
  });

  const connect = async (name: string, target: Target, database: string | null | undefined): Promise<OrmDriver> => {
    const driver = await app.container.child().resolve<OrmDriver>(target.type, [{ Name: `migration-${name}`, ...target.options, ...(database ? { Database: database } : {}) }]);
    await driver.connect();
    return driver;
  };

  const onServer = async (name: string, target: Target, sql: string): Promise<void> => {
    const admin = await connect(name, target, target.server?.admin);
    try {
      await admin.schema().raw(sql);
    } finally {
      await admin.disconnect();
    }
  };

  for (const [name, target] of Object.entries(TARGETS)) {
    it(`adds the columns on ${name} with sane values for existing rows, a lease that one taker wins, and a down that removes only them`, async function () {
      if (target.server) {
        try {
          await onServer(name, target, target.server.drop);
        } catch (err) {
          if (process.env.TENANCY_ORM_REQUIRE_SERVERS === '1') throw err;
          console.warn(`      ${name} is unreachable (${err instanceof Error ? err.message : String(err)}), skipped`);
          this.skip();
        }
        await onServer(name, target, `CREATE DATABASE ${DATABASE}`);
      }
      const driver = await connect(name, target, target.server ? DATABASE : undefined);
      try {
        await new Tenants_2026_11_16_00_00_00().up(driver);
        await driver.insert().into(TENANTS_TABLE).values({ id: 'old', slug: 'old', name: 'Old', state: 'active', domains: '', settings: '{}', created_at: '2026-11-01 00:00:00', updated_at: '2026-11-01 00:00:00' });
        const before = Object.keys(await rowOf(driver)).sort();

        await new Tenants_2026_12_01_00_00_00().up(driver);
        const after = await rowOf(driver);
        expect(after).to.include({ state: 'active', lifecycle: null, suspension: null, lifecycle_owner: null, lifecycle_until: null });
        expect(Number(after.lifecycle_epoch)).to.eq(0);

        const lease = new RowLease(driver, LIFECYCLE_LEASE_COLUMNS);
        const row = { table: TENANTS_TABLE, key: { id: 'old' } };
        const now = Date.UTC(2026, 11, 1);
        const taken = await Promise.all([lease.claim(row, 'one', LIFECYCLE_LEASE_MS, now), lease.claim(row, 'two', LIFECYCLE_LEASE_MS, now)]);
        expect(taken.filter((t) => t !== null)).to.deep.eq([{ epoch: 1 }]);
        expect(Number((await rowOf(driver)).lifecycle_until)).to.eq(now + LIFECYCLE_LEASE_MS);

        if (name === 'mssql') {
          // The ORM's DROP COLUMN leaves the column's DEFAULT constraint in place on MSSQL, which then refuses the drop.
          await expect(new Tenants_2026_12_01_00_00_00().down(driver)).to.be.rejectedWith(Error, 'lifecycle_epoch failed because one or more objects access this column');
          return;
        }
        await new Tenants_2026_12_01_00_00_00().down(driver);
        expect(Object.keys(await rowOf(driver)).sort()).to.deep.eq(before);
      } finally {
        await driver.disconnect();
        if (target.server) await onServer(name, target, target.server.drop);
      }
    });
  }
});
