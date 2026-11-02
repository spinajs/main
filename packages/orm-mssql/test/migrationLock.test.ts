/**
 * The mssql migration lock against a live SQL Server: a session-owned sp_getapplock on a pool of
 * one connection, plus the lock-table row an earlier release takes. Needs the `mssql` service of
 * the root docker-compose.yml, as mssql.test.ts does.
 */
import { DI } from '@spinajs/di';
import { DefaultMigrationService, IMigrationLockRequest, Migration, MIGRATION_TABLE_NAME, MigrationLock, MigrationLockLostException, migrationLockKey, MigrationRunner, OrmMigration, QueryContext, TableMigrationLock } from '@spinajs/orm';
import '@spinajs/log';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import mssql from 'mssql';
import { randomUUID } from 'node:crypto';

import { MsSqlMigrationLock, msSqlLockResource, MsSqlOrmDriver } from '../src/index.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const SERVER = {
  Host: process.env.ORM_TEST_MSSQL_HOST ?? 'localhost',
  Port: Number(process.env.ORM_TEST_MSSQL_PORT ?? 1433),
  User: process.env.ORM_TEST_MSSQL_USER ?? 'sa',
  Password: process.env.ORM_TEST_MSSQL_PASSWORD ?? 'yourStrong(!)Password',
  Options: { TrustServerCertificate: true },
};

async function driverOn(name: string, database: string, max = 4): Promise<MsSqlOrmDriver> {
  const driver = await DI.child().resolve(MsSqlOrmDriver, [{ Name: name, Driver: 'orm-driver-mssql', ...SERVER, Database: database, Pool: { Max: max } }]);
  await driver.connect();
  return driver;
}

describe('mssql migration lock (integration)', function () {
  this.timeout(60000);

  const database = `orm_miglock_${randomUUID().slice(0, 8)}`;
  let admin: MsSqlOrmDriver;
  let driver: MsSqlOrmDriver;
  // a second process's connection to the same database, with a pool of one
  let other: MsSqlOrmDriver;
  let resource: string;
  const ran: string[] = [];

  const holders = async () =>
    (await admin.executeOnDb(`SELECT request_session_id AS spid FROM sys.dm_tran_locks WHERE resource_type = 'APPLICATION' AND resource_database_id = DB_ID(?)`, [database], QueryContext.Select)) as Array<{ spid: number }>;

  @Migration('mssql-lock')
  class MsLock_KillsItsLock_2031_01_01_00_00_00 extends OrmMigration {
    public async up() {
      ran.push('first');
      for (const { spid } of await holders()) {
        await admin.executeOnDb(`KILL ${Number(spid)}`, [], QueryContext.Schema);
      }
    }
    public async down() {}
  }

  @Migration('mssql-lock')
  class MsLock_Second_2031_01_02_00_00_00 extends OrmMigration {
    public async up() {
      ran.push('second');
    }
    public async down() {}
  }

  @Migration('mssql-lock')
  class MsLock_Fails_2031_02_01_00_00_00 extends OrmMigration {
    public async up() {
      throw new Error('broken migration');
    }
    public async down() {}
  }

  const runner = (...migrations: Array<new () => OrmMigration>) =>
    new MigrationRunner({ Migrations: migrations.map((type) => ({ file: `${type.name}.ts`, name: type.name, type })), Connections: new Map([['mssql-lock', driver]]) });

  const service = (d: MsSqlOrmDriver, timeout = 1_500) => {
    d.Options.Migration = { ...d.Options.Migration, Lock: { Timeout: timeout } };
    return new DefaultMigrationService(d);
  };

  const request = (timeout = 1_500): IMigrationLockRequest => ({ key: migrationLockKey(driver, MIGRATION_TABLE_NAME), lockTable: `${MIGRATION_TABLE_NAME}_lock`, timeout, staleAfter: 600_000 });
  const isHeld = () => other.Container.resolve(MigrationLock, [other]).isHeld(request());

  before(async () => {
    admin = await driverOn('mssql-lock-admin', 'master');
    await admin.executeOnDb(`CREATE DATABASE [${database}]`, [], QueryContext.Schema);
    driver = await driverOn('mssql-lock', database);
    other = await driverOn('mssql-lock-other', database, 1);
    await new DefaultMigrationService(driver).ensureStorage();
    resource = msSqlLockResource(request().key);
  });

  after(async () => {
    for (const type of [MsLock_KillsItsLock_2031_01_01_00_00_00, MsLock_Second_2031_01_02_00_00_00, MsLock_Fails_2031_02_01_00_00_00]) {
      DI.unregister(type);
    }
    await driver?.disconnect();
    await other?.disconnect();
    await admin?.executeOnDb(`ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]`, [], QueryContext.Schema);
    await admin?.disconnect();
  });

  it('is the lock the driver registers', () => {
    expect(driver.Container.resolve(MigrationLock, [driver])).to.be.instanceOf(MsSqlMigrationLock);
  });

  it('a second connection waits, times out naming the app lock, and gets it once released', async () => {
    const first = await service(driver).acquireRunLock();

    await expect(service(other, 700).acquireRunLock()).to.be.rejectedWith(`Could not acquire migration lock on connection mssql-lock-other within 700ms - another migration run holds sp_getapplock '${resource}'`);
    expect(await isHeld()).to.be.true;
    expect(await holders()).to.have.length(1);

    await first.release();
    expect(await isHeld()).to.be.false;
    expect(await holders()).to.have.length(0);
    await (await service(other, 700).acquireRunLock()).release();
  });

  it('a second run of the same process waits too: every acquisition opens its own session, the lock being re-entrant within one', async () => {
    const first = await service(driver).acquireRunLock();

    await expect(service(driver, 700).acquireRunLock()).to.be.rejectedWith(/Could not acquire migration lock on connection mssql-lock within 700ms - another migration run holds sp_getapplock/);

    await first.assertHeld();
    await first.release();
  });

  it('holds no pooled connection: a connection with Pool.Max 1 still runs queries', async () => {
    const lock = await service(other).acquireRunLock();

    expect(await other.ping()).to.be.true;
    await lock.assertHeld();
    await lock.release();
  });

  it('a lock session killed mid-run stops the run before its next migration', async () => {
    ran.length = 0;

    await expect(runner(MsLock_KillsItsLock_2031_01_01_00_00_00, MsLock_Second_2031_01_02_00_00_00).up()).to.be.rejectedWith(MigrationLockLostException, /Migration lock on connection mssql-lock was lost: its session no longer holds sp_getapplock/);

    expect(ran).to.eql(['first']);
    expect(await isHeld(), 'the run gave the lock-table row back').to.be.false;
  });

  it('a failed run releases the lock', async () => {
    await expect(runner(MsLock_Fails_2031_02_01_00_00_00).up()).to.be.rejectedWith(/broken migration/);

    expect(await isHeld()).to.be.false;
    await (await service(other, 700).acquireRunLock()).release();
  });

  it('a closed holder connection frees the lock', async () => {
    const holder = new mssql.ConnectionPool({ server: SERVER.Host, port: SERVER.Port, user: SERVER.User, password: SERVER.Password, database, options: { trustServerCertificate: true }, pool: { min: 1, max: 1 } });
    await holder.connect();
    await holder.request().input('res', resource).query(`EXEC sp_getapplock @Resource = @res, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0`);
    expect(await holders()).to.have.length(1);

    await holder.close();

    await (await service(driver, 5_000).acquireRunLock()).release();
  });

  // a thief deletes only the row it judged stale, matched by the AcquiredAt it read: the value must round-trip exactly
  it('steals a stale row, matching it by the AcquiredAt read back', async () => {
    const lockTable = `${MIGRATION_TABLE_NAME}_lock`;
    const dead = { Id: 1, AcquiredAt: new Date(Date.now() - 60_000 + 123), Owner: 'dead-host:1:0badf00d' };

    await driver.insert().into(lockTable).values(dead);
    const [read] = (await driver.select().from(lockTable).where({ Id: 1 })) as Array<{ AcquiredAt: Date }>;
    const removed = (await driver.del().from(lockTable).where({ Id: 1, Owner: dead.Owner, AcquiredAt: read.AcquiredAt })) as unknown as { RowsAffected: number };
    expect(removed.RowsAffected).to.eq(1);

    await driver.insert().into(lockTable).values(dead);
    const lock = await driver.Container.resolve(MigrationLock, [driver]).acquire({ ...request(), staleAfter: 10_000 });
    await lock.release();
    expect(await isHeld()).to.be.false;
  });

  it('after a crash the next run takes over at once: the row the dead run marked does not wait for StaleAfter', async () => {
    const crashed = await service(driver).acquireRunLock();
    for (const { spid } of await holders()) {
      await admin.executeOnDb(`KILL ${Number(spid)}`, [], QueryContext.Schema);
    }

    await (await service(other, 2_000).acquireRunLock()).release();
    await crashed.release();
  });

  it('excludes a process of an earlier release that only takes the lock-table row, both ways', async () => {
    const earlier = other.Container.resolve(TableMigrationLock, [other]);
    const old = await earlier.acquire(request());

    await expect(service(driver, 700).acquireRunLock()).to.be.rejectedWith(/Could not acquire migration lock on connection mssql-lock within \d+ms - held by /);
    expect(await holders(), 'the refused run gave the app lock back').to.have.length(0);
    await old.release();

    const current = await service(driver).acquireRunLock();
    await expect(earlier.acquire(request(700))).to.be.rejectedWith(/held by /);
    await current.release();
  });
});
