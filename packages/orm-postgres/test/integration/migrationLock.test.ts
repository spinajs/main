import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import pg from 'pg';
import { DI } from '@spinajs/di';
import { advisoryKeyPair, DefaultMigrationService, IMigrationLockRequest, Migration, MIGRATION_TABLE_NAME, MigrationLock, MigrationLockLostException, migrationLockKey, MigrationRunner, OrmMigration, QueryContext, TableMigrationLock } from '@spinajs/orm';
import { PostgresMigrationLock, PostgresOrmDriver } from '../../src/index.js';
import { adminQuery, bootPostgres, PG_SERVER, PgTestDb, requirePostgres } from './support.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

describe('postgres migration lock (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb;
  // a second process's connection to the same database, with a pool of one
  let other: PostgresOrmDriver;
  let pair: [number, number];
  const ran: string[] = [];

  @Migration('pg')
  class PgLock_KillsItsLock_2031_01_01_00_00_00 extends OrmMigration {
    public async up() {
      ran.push('first');
      await adminQuery(`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND classid = ${pair[0] >>> 0} AND objid = ${pair[1] >>> 0} AND objsubid = 2`);
    }
    public async down() {}
  }

  @Migration('pg')
  class PgLock_Second_2031_01_02_00_00_00 extends OrmMigration {
    public async up() {
      ran.push('second');
    }
    public async down() {}
  }

  @Migration('pg')
  class PgLock_Fails_2031_02_01_00_00_00 extends OrmMigration {
    public async up() {
      throw new Error('broken migration');
    }
    public async down() {}
  }

  const runner = (...migrations: Array<new () => OrmMigration>) =>
    new MigrationRunner({ Migrations: migrations.map((type) => ({ file: `${type.name}.ts`, name: type.name, type })), Connections: new Map([['pg', pgdb.driver]]) });

  const service = (driver: PostgresOrmDriver, timeout = 1_500) => {
    driver.Options.Migration = { ...driver.Options.Migration, Lock: { Timeout: timeout } };
    return new DefaultMigrationService(driver);
  };

  const request = (timeout = 1_500): IMigrationLockRequest => ({ key: migrationLockKey(pgdb.driver, MIGRATION_TABLE_NAME), lockTable: `${MIGRATION_TABLE_NAME}_lock`, timeout, staleAfter: 600_000 });
  const isHeld = () => other.Container.resolve(MigrationLock, [other]).isHeld(request());

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('mig_lock');
    other = await DI.child().resolve(PostgresOrmDriver, [{ Driver: 'orm-driver-postgres', Name: 'pg-other', ...PG_SERVER, Database: pgdb.name, Pool: { Max: 1 } }]);
    await other.connect();
    await new DefaultMigrationService(pgdb.driver).ensureStorage();
    pair = advisoryKeyPair(request().key);
  });

  after(async () => {
    for (const type of [PgLock_KillsItsLock_2031_01_01_00_00_00, PgLock_Second_2031_01_02_00_00_00, PgLock_Fails_2031_02_01_00_00_00]) {
      DI.unregister(type);
    }
    await other?.disconnect();
    await pgdb?.dispose();
  });

  it('is the lock the driver registers', () => {
    expect(pgdb.driver.Container.resolve(MigrationLock, [pgdb.driver])).to.be.instanceOf(PostgresMigrationLock);
  });

  it('a second connection waits, times out naming the advisory lock, and gets it once released', async () => {
    const first = await service(pgdb.driver).acquireRunLock();

    await expect(service(other, 700).acquireRunLock()).to.be.rejectedWith(`Could not acquire migration lock on connection pg-other within 700ms - another migration run holds pg advisory lock (${pair[0]}, ${pair[1]})`);
    expect(await isHeld()).to.be.true;

    await first.release();
    expect(await isHeld()).to.be.false;
    await (await service(other, 700).acquireRunLock()).release();
  });

  it('a second run of the same process waits too: every acquisition opens its own session, the lock being re-entrant within one', async () => {
    const first = await service(pgdb.driver).acquireRunLock();

    await expect(service(pgdb.driver, 700).acquireRunLock()).to.be.rejectedWith(/Could not acquire migration lock on connection pg within 700ms - another migration run holds pg advisory lock/);

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

    await expect(runner(PgLock_KillsItsLock_2031_01_01_00_00_00, PgLock_Second_2031_01_02_00_00_00).up()).to.be.rejectedWith(MigrationLockLostException, /Migration lock on connection pg was lost: its session no longer holds pg advisory lock/);

    expect(ran).to.eql(['first']);
    expect(await isHeld(), 'the run gave the lock-table row back').to.be.false;
  });

  it('a failed run releases the lock', async () => {
    await expect(runner(PgLock_Fails_2031_02_01_00_00_00).up()).to.be.rejectedWith(/broken migration/);

    expect(await isHeld()).to.be.false;
    await (await service(other, 700).acquireRunLock()).release();
  });

  it('a dead holder session frees the lock', async () => {
    const holder = new pg.Client({ host: PG_SERVER.Host, port: PG_SERVER.Port, user: PG_SERVER.User, password: PG_SERVER.Password, database: pgdb.name });
    holder.on('error', () => undefined);
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1, $2)', pair);

    (holder as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();

    await (await service(pgdb.driver, 5_000).acquireRunLock()).release();
  });

  // a thief deletes only the row it judged stale, matched by the AcquiredAt it read: the value must round-trip exactly
  it('steals a stale row, matching it by the AcquiredAt read back', async () => {
    const lockTable = `${MIGRATION_TABLE_NAME}_lock`;
    const dead = { Id: 1, AcquiredAt: new Date(Date.now() - 60_000 + 123), Owner: 'dead-host:1:0badf00d' };

    await pgdb.driver.insert().into(lockTable).values(dead);
    const [read] = (await pgdb.driver.select().from(lockTable).where({ Id: 1 })) as Array<{ AcquiredAt: Date }>;
    const removed = (await pgdb.driver.del().from(lockTable).where({ Id: 1, Owner: dead.Owner, AcquiredAt: read.AcquiredAt })) as unknown as { RowsAffected: number };
    expect(removed.RowsAffected).to.eq(1);

    await pgdb.driver.insert().into(lockTable).values(dead);
    const lock = await pgdb.driver.Container.resolve(MigrationLock, [pgdb.driver]).acquire({ ...request(), staleAfter: 10_000 });
    await lock.release();
    expect(await isHeld()).to.be.false;
  });

  it('excludes a process of an earlier release that only takes the lock-table row, both ways', async () => {
    const earlier = other.Container.resolve(TableMigrationLock, [other]);
    const old = await earlier.acquire(request());

    await expect(service(pgdb.driver, 700).acquireRunLock()).to.be.rejectedWith(/Could not acquire migration lock on connection pg within \d+ms - held by /);
    expect(await pgdb.driver.executeOnDb(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2 AND classid = ${pair[0] >>> 0}`, [], QueryContext.Select)).to.have.length(0);
    await old.release();

    const current = await service(pgdb.driver).acquireRunLock();
    await expect(earlier.acquire(request(700))).to.be.rejectedWith(/held by /);
    await current.release();
  });
});
