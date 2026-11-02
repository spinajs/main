import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { DefaultMigrationService, IMigrationLockHandle, IMigrationLockRequest, MigrationLockLostException, Orm, OrmDriver, TableMigrationLock, migrationLockKey } from '@spinajs/orm';
import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import _ from 'lodash';
import 'mocha';
import '@spinajs/log';

import { SqliteOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';

const CONNECTION = 'sqlite-table-lock';
const TABLE = 'table_lock_migrations';
const LOCK_TABLE = `${TABLE}_lock`;

let dbFile = '';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class TableLockConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-sqlite', Filename: dbFile, Name: CONNECTION, Migration: { Table: TABLE } }] },
      },
      mergeArrays,
    );
  }
}

/** Holds its `acquire()` between reading the row of `gatedOwner` and removing it, so another writer gets in between. */
class GatedTableLock extends TableMigrationLock {
  public reached: Promise<void>;
  protected arrive!: () => void;
  protected gate: Promise<void>;
  public open!: () => void;

  constructor(
    driver: OrmDriver,
    protected gatedOwner = 'dead',
  ) {
    super(driver);
    this.reached = new Promise((resolve) => (this.arrive = resolve));
    this.gate = new Promise((resolve) => (this.open = resolve));
  }

  protected async holder(request: IMigrationLockRequest) {
    const found = await super.holder(request);

    if (found?.owner === this.gatedOwner) {
      this.arrive();
      await this.gate;
    }

    return found;
  }
}

describe('sqlite TableMigrationLock', function () {
  this.timeout(15_000);

  let dir = '';
  let orm: Orm;
  let driver: OrmDriver;

  const request = (over: Partial<IMigrationLockRequest> = {}): IMigrationLockRequest => ({ key: migrationLockKey(driver, TABLE), lockTable: LOCK_TABLE, timeout: 2_000, staleAfter: 600_000, ...over });

  const row = async () => ((await driver.select().from(LOCK_TABLE).where({ Id: 1 })) as Array<{ Owner: string; AcquiredAt: Date }>)[0];

  const writeRow = async (Owner: string, ageMs = 0) => {
    await driver.del().from(LOCK_TABLE).where({ Id: 1 });
    await driver.insert().into(LOCK_TABLE).values({ Id: 1, AcquiredAt: new Date(Date.now() - ageMs), Owner });
  };

  const settle = <T>(p: Promise<T>) => p.then((value) => ({ value, error: undefined as unknown }), (error: unknown) => ({ value: undefined, error }));

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-table-lock-'));
    dbFile = path.join(dir, 'table-lock.sqlite');
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    const container = DI.child();
    container.register(TableLockConf).as(Configuration);
    orm = await container.resolve(Orm);
    driver = orm.Connections.get(CONNECTION)!;

    await (await driver.Container.resolve(DefaultMigrationService, [driver])).ensureStorage();
  });

  beforeEach(async () => {
    await driver.del().from(LOCK_TABLE).where({ Id: 1 });
  });

  after(async () => {
    await orm.dispose();
    DI.clearCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('two contenders for one dead holder row: exactly one of them holds the lock', async () => {
    await writeRow('dead', 60_000);

    const first = new GatedTableLock(driver);
    const firstAcquire = settle(first.acquire(request({ timeout: 1_500, staleAfter: 5_000 })));
    await first.reached;

    const second = await new TableMigrationLock(driver).acquire(request({ staleAfter: 5_000 }));
    first.open();
    const { value: firstHandle, error } = await firstAcquire;

    expect(firstHandle, 'the second steal must not remove the row the first thief just wrote').to.be.undefined;
    expect((error as Error).message).to.satisfy((m: string) => m.startsWith(`Could not acquire migration lock on connection ${CONNECTION} within 1500ms - held by ${second.holder} since `));
    expect((await row()).Owner).to.eq(second.holder);

    await second.assertHeld();
    await second.release();
  });

  it('a thief does not delete a row refreshed after it read the row as stale', async () => {
    await writeRow('dead', 60_000);

    const thief = new GatedTableLock(driver);
    const stealing = settle(thief.acquire(request({ timeout: 700, staleAfter: 5_000 })));
    await thief.reached;

    await driver.update().in(LOCK_TABLE).update({ AcquiredAt: new Date() }).where({ Id: 1, Owner: 'dead' });
    thief.open();
    const { value, error } = await stealing;

    expect(value, 'the refreshed row is live').to.be.undefined;
    expect((error as Error).message).to.contain('held by dead since ').and.not.contain('attempt(s) to remove it as stale');
    expect((await row()).Owner).to.eq('dead');
  });

  it("a holder's refresh landing between a thief's stale read and its DELETE leaves exactly one run holding", async () => {
    const staleAfter = 3_000;
    const target = driver as unknown as { executeOnDb: (statement: unknown, ...rest: unknown[]) => Promise<unknown> };
    const original = target.executeOnDb;
    let refreshed!: () => void;
    const refreshCommitted = new Promise<void>((resolve) => (refreshed = resolve));
    let held = true;

    // the first refresh is stamped on time, at staleAfter / 3, but its UPDATE reaches the database
    // only after the row already reads as stale, as behind a busy single-connection pool
    target.executeOnDb = async function (this: unknown, statement: unknown, ...rest: unknown[]) {
      if (held && typeof statement === 'string' && statement.startsWith('UPDATE') && statement.includes(LOCK_TABLE)) {
        held = false;
        await delay(2_500);
        const result = await original.call(this, statement, ...rest);
        refreshed();
        return result;
      }

      return await original.call(this, statement, ...rest);
    };

    try {
      const holder = await new TableMigrationLock(driver).acquire(request({ staleAfter, timeout: 10_000 }));
      await delay(staleAfter + 100);

      const thief = new GatedTableLock(driver, holder.holder);
      const stealing = settle(thief.acquire(request({ staleAfter, timeout: 10_000 })));
      await thief.reached;
      await refreshCommitted;
      thief.open();
      await delay(150);

      expect((await settle(holder.assertHeld())).error, 'a refresh that landed after the row went stale proves nothing').to.be.instanceOf(MigrationLockLostException);
      expect((await row()).Owner, 'the refreshed row is not deleted').to.eq(holder.holder);

      await holder.release();
      const { value: taken, error } = await stealing;

      expect(error).to.be.undefined;
      expect((await row()).Owner).to.eq(taken!.holder);
      await taken!.assertHeld();
      expect((await settle(holder.assertHeld())).error).to.be.instanceOf(MigrationLockLostException);

      await taken!.release();
    } finally {
      target.executeOnDb = original;
    }
  });

  it('a run that lost its lock does not delete the thief row on release', async () => {
    const lost = await new TableMigrationLock(driver).acquire(request());
    await writeRow('thief');

    await lost.release();

    expect((await row())?.Owner).to.eq('thief');
  });

  it('a refresh that matches no row marks the lock lost for good', async () => {
    const lost = await new TableMigrationLock(driver).acquire(request({ staleAfter: 900 }));
    await writeRow('thief');

    // the refresh runs every 300 ms; without the affected-row check it "succeeds" and the lock never reads as lost
    const deadline = Date.now() + 2_500;
    let error: unknown;

    while (!error && Date.now() < deadline) {
      error = (await settle(lost.assertHeld())).error;
      await delay(50);
    }

    expect(error).to.be.instanceOf(MigrationLockLostException);
    expect((await settle(lost.assertHeld())).error, 'lost stays lost').to.be.instanceOf(MigrationLockLostException);

    await lost.release();
    expect((await row()).Owner).to.eq('thief');
  });

  it('isHeld() reads a missing lock table as not held', async () => {
    expect(await new TableMigrationLock(driver).isHeld(request({ lockTable: 'table_lock_never_created' }))).to.be.false;
  });

  describe('row of an advisory holder', () => {
    it('acquireUnderAdvisory() marks its row and removes a fresh marked row at once', async () => {
      await writeRow('other-host:4242:0badf00d:advisory');

      const start = Date.now();
      const handle: IMigrationLockHandle = await new TableMigrationLock(driver).acquireUnderAdvisory(request({ timeout: 400 }));

      expect(Date.now() - start, 'no poll wait for a marked row').to.be.lessThan(400);
      expect(handle.holder).to.match(/:advisory$/);
      expect((await row()).Owner).to.eq(handle.holder);

      await handle.release();
      expect(await row()).to.be.undefined;
    });

    it('acquireUnderAdvisory() keeps the StaleAfter rule for rows without the mark', async () => {
      for (const owner of ['old-host:4242', 'new-host:4242:0badf00d']) {
        await writeRow(owner);
        const { error } = await settle(new TableMigrationLock(driver).acquireUnderAdvisory(request({ timeout: 100 })));

        expect((error as Error)?.message, owner).to.contain(`held by ${owner} since `);
        expect((await row()).Owner).to.eq(owner);
      }

      await writeRow('old-host:4242', 60_000);
      const handle = await new TableMigrationLock(driver).acquireUnderAdvisory(request({ staleAfter: 5_000 }));

      expect((await row()).Owner).to.eq(handle.holder);
      await handle.release();
    });

    it('acquire() without the advisory lock keeps the StaleAfter rule for a marked row', async () => {
      await writeRow('other-host:4242:0badf00d:advisory');

      const { error } = await settle(new TableMigrationLock(driver).acquire(request({ timeout: 100 })));

      expect((error as Error)?.message).to.match(/held by other-host:4242:0badf00d:advisory since /);
      expect((await row()).Owner).to.eq('other-host:4242:0badf00d:advisory');
    });
  });
});
