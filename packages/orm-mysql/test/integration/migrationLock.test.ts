/**
 * The mysql migration lock against a live server: GET_LOCK on a dedicated connection, plus the
 * lock-table row an earlier release takes.
 *
 *   docker compose --profile test up -d mysql
 *   npx ts-mocha -p tsconfig.json test/integration/migrationLock.test.ts
 */
import { DI } from '@spinajs/di';
import { DefaultMigrationService, IMigrationLockRequest, Migration, MIGRATION_TABLE_NAME, MigrationLock, MigrationLockLostException, migrationLockKey, MigrationRunner, OrmMigration, QueryContext, TableMigrationLock } from '@spinajs/orm';
import '@spinajs/log';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';

import { MySqlMigrationLock, mySqlLockName, MySqlOrmDriver } from '../../src/index.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};

async function driverOn(name: string, database: string, max = 4): Promise<MySqlOrmDriver> {
  const driver = await DI.child().resolve(MySqlOrmDriver, [{ Name: name, Driver: 'orm-driver-mysql', ...SERVER, Database: database, Pool: { Max: max } }]);
  await driver.connect();
  return driver;
}

describe('mysql migration lock (integration)', function () {
  this.timeout(60000);

  const database = `orm_miglock_${randomUUID().slice(0, 8)}`;
  let admin: MySqlOrmDriver;
  let driver: MySqlOrmDriver;
  // a second process's connection to the same database, with a pool of one
  let other: MySqlOrmDriver;
  let lockName: string;
  const ran: string[] = [];

  @Migration('mysql-lock')
  class MyLock_KillsItsLock_2031_01_01_00_00_00 extends OrmMigration {
    public async up() {
      ran.push('first');
      const [{ id }] = (await admin.executeOnDb('SELECT IS_USED_LOCK(?) AS id', [lockName], QueryContext.Select)) as Array<{ id: number }>;
      await admin.executeOnDb(`KILL ${Number(id)}`, [], QueryContext.Schema);
    }
    public async down() {}
  }

  @Migration('mysql-lock')
  class MyLock_Second_2031_01_02_00_00_00 extends OrmMigration {
    public async up() {
      ran.push('second');
    }
    public async down() {}
  }

  @Migration('mysql-lock')
  class MyLock_Fails_2031_02_01_00_00_00 extends OrmMigration {
    public async up() {
      throw new Error('broken migration');
    }
    public async down() {}
  }

  const runner = (...migrations: Array<new () => OrmMigration>) =>
    new MigrationRunner({ Migrations: migrations.map((type) => ({ file: `${type.name}.ts`, name: type.name, type })), Connections: new Map([['mysql-lock', driver]]) });

  const service = (d: MySqlOrmDriver, timeout = 1_500) => {
    d.Options.Migration = { ...d.Options.Migration, Lock: { Timeout: timeout } };
    return new DefaultMigrationService(d);
  };

  const request = (timeout = 1_500): IMigrationLockRequest => ({ key: migrationLockKey(driver, MIGRATION_TABLE_NAME), lockTable: `${MIGRATION_TABLE_NAME}_lock`, timeout, staleAfter: 600_000 });
  const isHeld = () => other.Container.resolve(MigrationLock, [other]).isHeld(request());

  before(async () => {
    admin = await driverOn('mysql-lock-admin', 'mysql');
    await admin.schema().createDatabase(database);
    driver = await driverOn('mysql-lock', database);
    other = await driverOn('mysql-lock-other', database, 1);
    await new DefaultMigrationService(driver).ensureStorage();
    lockName = mySqlLockName(request().key);
  });

  after(async () => {
    for (const type of [MyLock_KillsItsLock_2031_01_01_00_00_00, MyLock_Second_2031_01_02_00_00_00, MyLock_Fails_2031_02_01_00_00_00]) {
      DI.unregister(type);
    }
    await driver?.disconnect();
    await other?.disconnect();
    await admin?.executeOnDb(`DROP DATABASE IF EXISTS \`${database}\``, [], QueryContext.Schema);
    await admin?.disconnect();
  });

  it('is the lock the driver registers, named within the 64 characters GET_LOCK allows', () => {
    expect(driver.Container.resolve(MigrationLock, [driver])).to.be.instanceOf(MySqlMigrationLock);
    expect(lockName.length).to.be.at.most(64);
  });

  it('a second connection waits, times out naming the lock, and gets it once released', async () => {
    const first = await service(driver).acquireRunLock();

    await expect(service(other, 700).acquireRunLock()).to.be.rejectedWith(`Could not acquire migration lock on connection mysql-lock-other within 700ms - another migration run holds GET_LOCK('${lockName}')`);
    expect(await isHeld()).to.be.true;

    await first.release();
    expect(await isHeld()).to.be.false;
    await (await service(other, 700).acquireRunLock()).release();
  });

  it('a second run of the same process waits too: every acquisition opens its own session, the lock being re-entrant within one', async () => {
    const first = await service(driver).acquireRunLock();

    await expect(service(driver, 700).acquireRunLock()).to.be.rejectedWith(/Could not acquire migration lock on connection mysql-lock within 700ms - another migration run holds GET_LOCK/);

    await first.assertHeld();
    await first.release();
  });

  it('holds no pooled connection: a connection with Pool.Max 1 still runs queries', async () => {
    const lock = await service(other).acquireRunLock();

    expect(await other.ping()).to.be.true;
    await lock.assertHeld();
    await lock.release();
  });

  // the lock-table refresh reads 0 affected rows as "taken by another run": mysql2 must report matched rows, not changed ones
  it('the pool reports matched rows ( FOUND_ROWS ), so an unchanged refresh still counts as ours', async () => {
    const lock = await service(driver).acquireRunLock();

    const result = (await driver.executeOnDb(`UPDATE \`${MIGRATION_TABLE_NAME}_lock\` SET Owner = Owner WHERE Id = 1`, [], QueryContext.Update)) as { RowsAffected: number };
    expect(result.RowsAffected).to.eq(1);

    await lock.release();
  });

  it('a lock connection killed mid-run stops the run before its next migration', async () => {
    ran.length = 0;

    await expect(runner(MyLock_KillsItsLock_2031_01_01_00_00_00, MyLock_Second_2031_01_02_00_00_00).up()).to.be.rejectedWith(MigrationLockLostException, /Migration lock on connection mysql-lock was lost: its session no longer holds GET_LOCK/);

    expect(ran).to.eql(['first']);
    expect(await isHeld(), 'the run gave the lock-table row back').to.be.false;
  });

  it('a failed run releases the lock', async () => {
    await expect(runner(MyLock_Fails_2031_02_01_00_00_00).up()).to.be.rejectedWith(/broken migration/);

    expect(await isHeld()).to.be.false;
    await (await service(other, 700).acquireRunLock()).release();
  });

  it('a dead holder connection frees the lock', async () => {
    const holder = await mysql.createConnection({ host: SERVER.Host, port: SERVER.Port, user: SERVER.User, password: SERVER.Password });
    await holder.query('SELECT GET_LOCK(?, 0)', [lockName]);

    holder.destroy();

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
    const [{ id }] = (await admin.executeOnDb('SELECT IS_USED_LOCK(?) AS id', [lockName], QueryContext.Select)) as Array<{ id: number }>;
    await admin.executeOnDb(`KILL ${Number(id)}`, [], QueryContext.Schema);

    await (await service(other, 2_000).acquireRunLock()).release();
    await crashed.release();
  });

  it('excludes a process of an earlier release that only takes the lock-table row, both ways', async () => {
    const earlier = other.Container.resolve(TableMigrationLock, [other]);
    const old = await earlier.acquire(request());

    await expect(service(driver, 700).acquireRunLock()).to.be.rejectedWith(/Could not acquire migration lock on connection mysql-lock within \d+ms - held by /);
    const [{ id }] = (await admin.executeOnDb('SELECT IS_USED_LOCK(?) AS id', [lockName], QueryContext.Select)) as Array<{ id: number | null }>;
    expect(id, 'the refused run gave GET_LOCK back').to.be.null;
    await old.release();

    const current = await service(driver).acquireRunLock();
    await expect(earlier.acquire(request(700))).to.be.rejectedWith(/held by /);
    await current.release();
  });
});
