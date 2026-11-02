import { Configuration } from '@spinajs/configuration';
import { Class, ClassInfo, DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import * as sinon from 'sinon';
import { Log } from '@spinajs/log-common';
import { FakeSqliteDriver, TEST_TABLE_INFO, bootstrapAll, makeDriver, registerFakes, stubDb, logText } from './misc.js';
import {
  DefaultMigrationService,
  IMigrationDownOptions,
  IMigrationLockHandle,
  IMigrationLockRequest,
  IMigrationRecord,
  IMigrationRunOptions,
  IMigrationStatusEntry,
  IMigrationUnit,
  MIGRATION_TABLE_NAME,
  Migration,
  MigrationLock,
  MigrationLockLostException,
  MigrationResolveAction,
  MigrationRunner,
  OrmMigration,
  OrmMigrationService,
  TableMigrationLock,
  advisoryKeyPair,
  migrationLockKey,
} from '../src/index.js';
import { DeleteQueryBuilder, InsertQueryBuilder, SelectQueryBuilder, UpdateQueryBuilder } from '../src/builders.js';
import { OrmDriver } from '../src/driver.js';
import '../src/bootstrap.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const LOCK_TABLE = `${MIGRATION_TABLE_NAME}_lock`;
const SECOND_DRIVER_TOKEN = 'migration-lock-test-second-sqlite-driver';

class MigrationLockTest_SecondSqliteDriver extends FakeSqliteDriver {}

async function makeSecondDriver(): Promise<FakeSqliteDriver> {
  const conf = await DI.resolve(Configuration);
  const opts = conf.get<Array<{ Name: string }>>('db.Connections').find((c) => c.Name === 'SampleConnection1');

  return (await DI.resolve<OrmDriver>(SECOND_DRIVER_TOKEN, [opts])) as FakeSqliteDriver;
}

const request = (over: Partial<IMigrationLockRequest> = {}): IMigrationLockRequest => ({ key: 'k', lockTable: LOCK_TABLE, timeout: 2_000, staleAfter: 600_000, ...over });

const ci = (type: Class<OrmMigration>): ClassInfo<OrmMigration> => ({ file: `${type.name}.registered`, name: type.name, type });

const host = (migrations: Array<Class<OrmMigration>>, connections: OrmDriver[]) => ({
  Migrations: migrations.map(ci),
  Connections: new Map<string, OrmDriver>(connections.map((d) => [d.Options.Name, d])),
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A lock table that behaves like one: a unique row `Id = 1`, refreshed by UPDATE, dropped by DELETE. */
function fakeLockTable(options: { failRefresh?: boolean } = {}) {
  const state = { row: undefined as { Id: number; AcquiredAt: Date; Owner: string } | undefined, refreshes: 0, deletes: 0 };

  sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
    if (b instanceof InsertQueryBuilder && b.Table === LOCK_TABLE) {
      if (state.row) {
        throw new Error('UNIQUE constraint failed');
      }

      state.row = { Id: 1, AcquiredAt: b.getColumnValues('AcquiredAt')[0] as Date, Owner: String(b.getColumnValues('Owner')[0]) };
      return [];
    }

    if (b instanceof UpdateQueryBuilder && b.Table === LOCK_TABLE) {
      if (options.failRefresh) {
        throw new Error('connection reset');
      }

      state.refreshes++;
      if (state.row) {
        state.row.AcquiredAt = (b.Value as { AcquiredAt: Date }).AcquiredAt;
      }
      return [];
    }

    if (b instanceof DeleteQueryBuilder && b.Table === LOCK_TABLE) {
      state.deletes++;
      state.row = undefined;
      return [];
    }

    if (b instanceof SelectQueryBuilder && b.Table === LOCK_TABLE) {
      return state.row ? [{ ...state.row }] : [];
    }

    if (b instanceof SelectQueryBuilder) {
      return [];
    }

    return [{ 1: 1 }];
  });

  return state;
}

/** Hands out handles that record into `calls`; registered over `MigrationLock` in a driver container. */
class MigrationLockTest_RecordingLock extends MigrationLock {
  public static calls: string[] = [];
  public static requests: IMigrationLockRequest[] = [];
  public static held = false;
  public static assertAfter = Number.POSITIVE_INFINITY;
  public static failRelease = false;

  public async acquire(req: IMigrationLockRequest): Promise<IMigrationLockHandle> {
    const self = MigrationLockTest_RecordingLock;
    const name = this.driver.Options.Name;
    let asserts = 0;

    self.requests.push(req);
    self.calls.push(`lock:${name}`);

    return {
      holder: `recording:${name}`,
      assertHeld: async () => {
        if (++asserts > self.assertAfter) {
          throw new MigrationLockLostException(`lost on ${name}`);
        }
      },
      release: async () => {
        self.calls.push(`release:${name}`);

        if (self.failRelease) {
          throw new Error('session already gone');
        }
      },
    };
  }

  public async isHeld(_req: IMigrationLockRequest): Promise<boolean> {
    return MigrationLockTest_RecordingLock.held;
  }

  public static reset() {
    this.calls = [];
    this.requests = [];
    this.held = false;
    this.assertAfter = Number.POSITIVE_INFINITY;
    this.failRelease = false;
  }
}

const pending = (u: IMigrationUnit, connection: string): IMigrationStatusEntry => ({
  name: u.name,
  connection,
  applied: false,
  failed: false,
  rolledBack: false,
  pending: true,
  interrupted: false,
  batch: null,
  startedAt: null,
  finishedAt: null,
  checksumMismatch: false,
});

/** Records the runner's calls. Written before run locks existed: no `acquireRunLock`, so it locks on its own. */
class MigrationLockTest_LegacyService extends OrmMigrationService {
  public static calls: string[] = [];

  protected get name() {
    return this.driver.Options.Name;
  }

  public async ensureStorage(): Promise<void> {}

  public async up(_units: IMigrationUnit[], options?: IMigrationRunOptions): Promise<OrmMigration[]> {
    MigrationLockTest_LegacyService.calls.push(`up:${this.name}:${options?.locked && options.lock ? 'locked' : 'unlocked'}`);
    return [];
  }

  public async down(_units: IMigrationUnit[], options?: IMigrationDownOptions): Promise<OrmMigration[]> {
    MigrationLockTest_LegacyService.calls.push(`down:${this.name}:${options?.locked && options.lock ? 'locked' : 'unlocked'}`);
    return [];
  }

  public async status(units: IMigrationUnit[]): Promise<IMigrationStatusEntry[]> {
    MigrationLockTest_LegacyService.calls.push(`status:${this.name}`);
    return units.map((u) => pending(u, this.name));
  }

  public async resolve(_name: string, _action: MigrationResolveAction): Promise<void> {
    MigrationLockTest_LegacyService.calls.push(`resolve:${this.name}`);
  }
}

class MigrationLockTest_RecordingService extends MigrationLockTest_LegacyService {
  public async acquireRunLock(): Promise<IMigrationLockHandle> {
    const calls = MigrationLockTest_LegacyService.calls;
    const name = this.name;
    calls.push(`lock:${name}`);

    return {
      holder: `recording:${name}`,
      assertHeld: async () => undefined,
      release: async () => {
        calls.push(`release:${name}`);
      },
    };
  }
}

describe('Migration lock', () => {
  let preRegistered: unknown[] = [];

  before(() => {
    registerFakes();
    DI.register(MigrationLockTest_SecondSqliteDriver).as(SECOND_DRIVER_TOKEN);
    DI.register(MigrationLockTest_RecordingService).as('migration-lock-test-recording-service');
    DI.register(MigrationLockTest_LegacyService).as('migration-lock-test-legacy-service');
  });

  after(() => {
    DI.unregister(MigrationLockTest_SecondSqliteDriver);
    DI.unregister(MigrationLockTest_RecordingService);
    DI.unregister(MigrationLockTest_LegacyService);
  });

  beforeEach(async () => {
    await bootstrapAll();
    TEST_TABLE_INFO[MIGRATION_TABLE_NAME] = ['Migration', 'CreatedAt', 'StartedAt', 'FinishedAt', 'RolledBackAt', 'Logs', 'Checksum', 'Batch'].map((Name) => ({ Name })) as any;
    preRegistered = [...(DI.getRegisteredTypes('__migrations__') ?? [])];
    MigrationLockTest_RecordingLock.reset();
    MigrationLockTest_LegacyService.calls = [];
  });

  afterEach(() => {
    // identity decides what to remove, DI.unregister removes by name: hence the class-name prefix
    for (const t of [...(DI.getRegisteredTypes('__migrations__') ?? [])]) {
      if (!preRegistered.includes(t)) {
        DI.unregister(t);
      }
    }

    DI.clearCache();
    sinon.restore();
    delete TEST_TABLE_INFO[MIGRATION_TABLE_NAME];
  });

  describe('TableMigrationLock', () => {
    it('refuses a second holder until the first releases', async () => {
      const driver = await makeDriver();
      fakeLockTable();

      const first = await new TableMigrationLock(driver).acquire(request());
      await expect(new TableMigrationLock(driver).acquire(request({ timeout: 600 }))).to.be.rejectedWith(/Could not acquire migration lock on connection sqlite within 600ms - held by /);
      await expect(new TableMigrationLock(driver).acquire(request({ timeout: 100 })), 'a dead holder blocks migrate-resolve too: the message names the way out').to.be.rejectedWith(
        /the row goes stale at \S+ \( Migration\.Lock\.StaleAfter \) and the next run takes it; to go on sooner, delete it from spinajs_migration_lock by hand/,
      );

      await first.release();
      await (await new TableMigrationLock(driver).acquire(request({ timeout: 600 }))).release();
    }).timeout(5_000);

    it('keeps a live holder fresh, so a run outlasting StaleAfter is not stolen', async () => {
      const driver = await makeDriver();
      const table = fakeLockTable();
      const first = await new TableMigrationLock(driver).acquire(request({ staleAfter: 300 }));

      // the second poll lands well past StaleAfter after the INSERT: without the refresh it steals
      await expect(new TableMigrationLock(driver).acquire(request({ timeout: 900, staleAfter: 300 }))).to.be.rejectedWith(/Could not acquire migration lock/);

      expect(table.deletes, 'a live holder must not be stolen').to.eq(0);
      expect(table.refreshes).to.be.greaterThan(0);
      await first.assertHeld();
      await first.release();
    }).timeout(5_000);

    it('stops refreshing once released', async () => {
      const driver = await makeDriver();
      const table = fakeLockTable();
      const lock = await new TableMigrationLock(driver).acquire(request({ staleAfter: 90 }));

      await delay(100);
      await lock.release();
      const refreshes = table.refreshes;
      await delay(150);

      expect(refreshes).to.be.greaterThan(0);
      expect(table.refreshes, 'a released lock must not touch the next holder row').to.eq(refreshes);
    });

    it('is lost once refreshing has failed for longer than StaleAfter', async () => {
      const driver = await makeDriver();
      fakeLockTable({ failRefresh: true });
      const lock = await new TableMigrationLock(driver).acquire(request({ staleAfter: 150 }));

      await lock.assertHeld();
      await delay(250);

      await expect(lock.assertHeld()).to.be.rejectedWith(MigrationLockLostException, /Migration lock on connection sqlite was lost/);
      await lock.release();
    });

    it('isHeld() reads a fresh row as held and a stale one as abandoned', async () => {
      const driver = await makeDriver();
      fakeLockTable();
      const lock = await new TableMigrationLock(driver).acquire(request());

      expect(await new TableMigrationLock(driver).isHeld(request())).to.be.true;
      expect(await new TableMigrationLock(driver).isHeld(request({ staleAfter: -1 }))).to.be.false;

      await lock.release();
      expect(await new TableMigrationLock(driver).isHeld(request())).to.be.false;
    });
  });

  describe('MigrationLock token', () => {
    it('every driver gets TableMigrationLock unless it registers its own', async () => {
      const driver = await makeDriver();

      expect(driver.Container.resolve(MigrationLock, [driver])).to.be.instanceOf(TableMigrationLock);
    });

    it('migrationLockKey names the database, the schema and the tracking table; advisoryKeyPair is two stable int32', () => {
      const fake = { Options: { Database: 'shop' } } as OrmDriver;

      expect(migrationLockKey(fake, 'spinajs_migration')).to.eq('spinajs_migration:shop::spinajs_migration');
      expect(migrationLockKey({ Options: {} } as OrmDriver, 't')).to.eq('spinajs_migration:::t');

      const [k1, k2] = advisoryKeyPair('spinajs_migration:shop:spinajs_migration');
      expect(advisoryKeyPair('spinajs_migration:shop:spinajs_migration')).to.eql([k1, k2]);
      expect(Number.isInteger(k1) && k1 >= -(2 ** 31) && k1 < 2 ** 31).to.be.true;
      expect(Number.isInteger(k2) && k2 >= -(2 ** 31) && k2 < 2 ** 31).to.be.true;
    });

    it('two connections on one database with different schemas get different keys', () => {
      const tenant = (Schema: string) => ({ Options: { Database: 'shop', Options: { Schema } } }) as OrmDriver;

      expect(migrationLockKey(tenant('tenant_a'), 'spinajs_migration')).to.eq('spinajs_migration:shop:tenant_a:spinajs_migration');
      expect(migrationLockKey(tenant('tenant_a'), 'spinajs_migration')).to.not.eq(migrationLockKey(tenant('tenant_b'), 'spinajs_migration'));
    });

    it('the service takes the lock the driver registered, with the connection key and settings', async () => {
      const driver = await makeDriver();
      driver.Container.register(MigrationLockTest_RecordingLock).as(MigrationLock);
      stubDb([]);

      const handle = await new DefaultMigrationService(driver).acquireRunLock();

      expect(handle.holder).to.eq('recording:sqlite');
      expect(MigrationLockTest_RecordingLock.requests).to.eql([{ key: 'spinajs_migration:::spinajs_migration', lockTable: LOCK_TABLE, timeout: 30_000, staleAfter: 600_000 }]);
    });

    it("Lock.Mode 'table' takes the lock-table row even where the driver registered another lock", async () => {
      const driver = await makeDriver();
      driver.Container.register(MigrationLockTest_RecordingLock).as(MigrationLock);
      driver.Options.Migration = { ...driver.Options.Migration, Lock: { Mode: 'table' } };
      const exec = stubDb([]);

      const handle = await new DefaultMigrationService(driver).acquireRunLock();
      await handle.release();

      expect(MigrationLockTest_RecordingLock.calls).to.eql([]);
      expect(exec.getCalls().filter((c) => c.args[0] instanceof InsertQueryBuilder && c.args[0].Table === LOCK_TABLE)).to.have.length(1);
    });

    it("status() asks the driver's lock whether a run is in progress", async () => {
      @Migration('sqlite')
      class MigrationLockTest_Open_2021_01_01_00_00_00 extends OrmMigration {
        public async up() {}
        public async down() {}
      }

      const driver = await makeDriver();
      driver.Container.register(MigrationLockTest_RecordingLock).as(MigrationLock);
      const open: IMigrationRecord = { Migration: MigrationLockTest_Open_2021_01_01_00_00_00.name, CreatedAt: new Date(), StartedAt: new Date(), FinishedAt: null, RolledBackAt: null, Logs: null, Checksum: null, Batch: 0 };
      stubDb([open]);
      const unit: IMigrationUnit = { name: open.Migration, created: undefined as any, type: MigrationLockTest_Open_2021_01_01_00_00_00 };
      const svc = new DefaultMigrationService(driver);

      MigrationLockTest_RecordingLock.held = true;
      expect((await svc.status([unit]))[0].interrupted, 'a run holds it open').to.be.false;

      MigrationLockTest_RecordingLock.held = false;
      expect((await svc.status([unit]))[0].interrupted, 'nobody holds the lock').to.be.true;
    });
  });

  describe('MigrationRunner run lock', () => {
    function threeUnits() {
      @Migration('SampleConnection1')
      class MigrationLockTest_A1_2021_02_01_00_00_00 extends OrmMigration {
        public async up() {}
        public async down() {}
      }

      @Migration('sqlite')
      class MigrationLockTest_B1_2021_02_02_00_00_00 extends OrmMigration {
        public async up() {}
        public async down() {}
      }

      @Migration('SampleConnection1')
      class MigrationLockTest_A2_2021_02_03_00_00_00 extends OrmMigration {
        public async up() {}
        public async down() {}
      }

      return [MigrationLockTest_A1_2021_02_01_00_00_00, MigrationLockTest_B1_2021_02_02_00_00_00, MigrationLockTest_A2_2021_02_03_00_00_00];
    }

    async function recordingRunner(token = 'migration-lock-test-recording-service') {
      const sqlite = await makeDriver();
      const sample = await makeSecondDriver();

      for (const d of [sqlite, sample]) {
        d.Options.Migration = { ...d.Options.Migration, Service: token };
      }

      return { runner: new MigrationRunner(host(threeUnits(), [sqlite, sample])), sqlite };
    }

    it('takes each connection lock once for the whole run, in name order, before planning', async () => {
      await (await recordingRunner()).runner.up();

      expect(MigrationLockTest_LegacyService.calls).to.eql([
        'lock:SampleConnection1',
        'lock:sqlite',
        'status:SampleConnection1',
        'status:sqlite',
        'up:SampleConnection1:locked',
        'up:sqlite:locked',
        'up:SampleConnection1:locked',
        'release:sqlite',
        'release:SampleConnection1',
      ]);
    });

    it('a service without acquireRunLock keeps locking inside its own calls', async () => {
      const { runner } = await recordingRunner('migration-lock-test-legacy-service');

      await runner.up(undefined, { connection: 'sqlite' });

      expect(MigrationLockTest_LegacyService.calls).to.eql(['status:sqlite', 'up:sqlite:unlocked']);
    });

    it('down() and resolve() hold the run lock too', async () => {
      const { runner } = await recordingRunner();

      await runner.down(undefined, { connection: 'sqlite' });
      await runner.resolve('MigrationLockTest_A1_2021_02_01_00_00_00', 'applied');

      expect(MigrationLockTest_LegacyService.calls).to.eql(['lock:sqlite', 'down:sqlite:locked', 'release:sqlite', 'lock:SampleConnection1', 'resolve:SampleConnection1', 'release:SampleConnection1']);
    });

    it('withRunLock() lets a caller hold the locks across several calls', async () => {
      const { runner } = await recordingRunner();

      await runner.withRunLock('sqlite', async () => {
        await runner.up(undefined, { connection: 'sqlite', locked: true });
        await runner.up(undefined, { connection: 'sqlite', locked: true });
      });

      expect(MigrationLockTest_LegacyService.calls).to.eql(['lock:sqlite', 'status:sqlite', 'up:sqlite:locked', 'status:sqlite', 'up:sqlite:locked', 'release:sqlite']);
    });

    it('a lost lock stops the run before the next migration and records no failure', async () => {
      @Migration('sqlite')
      class MigrationLockTest_First_2021_03_01_00_00_00 extends OrmMigration {
        public async up() {}
        public async down() {}
      }

      @Migration('sqlite')
      class MigrationLockTest_Second_2021_03_02_00_00_00 extends OrmMigration {
        public async up() {}
        public async down() {}
      }

      const driver = await makeDriver();
      driver.Container.register(MigrationLockTest_RecordingLock).as(MigrationLock);
      stubDb([]);
      const first = sinon.spy(MigrationLockTest_First_2021_03_01_00_00_00.prototype, 'up');
      const second = sinon.spy(MigrationLockTest_Second_2021_03_02_00_00_00.prototype, 'up');
      const failed = sinon.spy(DefaultMigrationService.prototype as any, 'markFailed');

      // the runner checks once before the stretch, the service once before each migration
      MigrationLockTest_RecordingLock.assertAfter = 2;
      const runner = new MigrationRunner(host([MigrationLockTest_First_2021_03_01_00_00_00, MigrationLockTest_Second_2021_03_02_00_00_00], [driver]));

      await expect(runner.up()).to.be.rejectedWith(MigrationLockLostException, 'lost on sqlite');

      expect(first.calledOnce).to.be.true;
      expect(second.called, 'nothing may run once the lock is lost').to.be.false;
      expect(failed.called, 'the migration did not fail, it never started').to.be.false;
      expect(MigrationLockTest_RecordingLock.calls).to.eql(['lock:sqlite', 'release:sqlite']);
    });

    it('a lock that cannot be released is logged, not thrown', async () => {
      @Migration('sqlite')
      class MigrationLockTest_Only_2021_04_01_00_00_00 extends OrmMigration {
        public async up() {}
        public async down() {}
      }

      const driver = await makeDriver();
      driver.Container.register(MigrationLockTest_RecordingLock).as(MigrationLock);
      stubDb([]);
      MigrationLockTest_RecordingLock.failRelease = true;
      const runner = new MigrationRunner(host([MigrationLockTest_Only_2021_04_01_00_00_00], [driver]));
      const error = sinon.spy(Reflect.get(runner, 'Log') as Log, 'error');

      const { executed } = await runner.up();

      expect(executed).to.have.length(1);
      const loud = error.getCalls().find((c) => (c.args[0] as { error?: Error } | undefined)?.error?.message === 'session already gone');
      expect(loud).to.not.be.undefined;
      expect(logText(loud!)).to.contain('recording:sqlite');
    });

    it('Lock.Enabled false takes no run lock', async () => {
      const { runner, sqlite } = await recordingRunner();
      sqlite.Options.Migration = { ...sqlite.Options.Migration, Lock: { Enabled: false } };

      await runner.up(undefined, { connection: 'sqlite' });

      expect(MigrationLockTest_LegacyService.calls).to.eql(['status:sqlite', 'up:sqlite:unlocked']);
    });
  });
});
