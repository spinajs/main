import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Orm, OrmDriver, QueryContext } from '@spinajs/orm';
import { LeaseStore, RunModel, ScheduleModel, SqlDbTimeSource } from '../../src/index.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

const MIN = 60_000;
// Beyond 2^31 on purpose: the columns must be BIGINT on every driver.
const T = Date.parse('2026-01-05T10:00:00Z');

const queued = (id: string, extra: Partial<RunModel> = {}) =>
  RunModel.create({
    Id: id,
    Schedule: 'a',
    Trigger: 'manual',
    Status: 'queued',
    Attempt: 1,
    MaxAttempts: 3,
    CreatedAt: T,
    Progress: 0,
    CancelRequested: false,
    Forced: false,
    ...extra,
  });

type RawDriver = OrmDriver & { executeOnDb(sql: string, p: unknown[], c: QueryContext): Promise<unknown> };
const defaultDriver = async () => (await DI.resolve(Orm)).Connections.get('default') as RawDriver;

/**
 * Runs `work` in a transaction that stays open until `commit()`, so a competing statement
 * started meanwhile on another pooled connection has to wait for the row lock.
 */
async function heldOpen<T>(work: () => Promise<T>): Promise<{ result: T; commit: () => Promise<void> }> {
  const driver = await defaultDriver();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let done!: (value: T) => void;
  let fail!: (err: unknown) => void;
  const result = new Promise<T>((resolve, reject) => ((done = resolve), (fail = reject)));
  const committed = driver.transaction(async () => {
    try {
      done(await work());
    } catch (err) {
      fail(err);
      throw err;
    }
    await gate;
  });
  committed.catch(() => undefined);
  return {
    result: await result,
    commit: async () => {
      release();
      await committed;
    },
  };
}

async function losesAfterWaitingOn(
  held: { commit: () => Promise<void> },
  competing: () => Promise<boolean>,
): Promise<boolean> {
  let settled = false;
  const competitor = competing().finally(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(settled, 'the competing UPDATE must wait for the row lock').to.eq(false);
  await held.commit();
  return !(await competitor);
}

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`lease integration (${target.name})`, function () {
    this.timeout(60_000);

    beforeEach(async () => {
      await bootRealDb(target);
      await ScheduleModel.create({
        Name: 'a',
        Definition: {},
        DefinitionHash: 'h',
        NextRunAt: T,
        Paused: false,
        HardPaused: false,
        ConsecutiveFailures: 0,
        Orphaned: false,
        UpdatedAt: T,
      });
    });

    it('reads database time', async () => {
      const ms = await DI.resolve(SqlDbTimeSource).read();
      expect(Math.abs(ms - Date.now())).to.be.lessThan(10_000);
    });

    it('three replicas: N occurrences produce exactly N claims', async () => {
      const stores = ['r1', 'r2', 'r3'].map((id) => DI.resolve(LeaseStore, [id]));
      const N = 20;
      const winsPerOccurrence: number[] = [];
      for (let i = 0; i < N; i++) {
        const o = { name: 'a', expectedNextRunAt: T + i * MIN, nextRunAt: T + (i + 1) * MIN, now: T + i * MIN };
        const results = await Promise.all(stores.map((s) => s.tryClaimOccurrence(o)));
        winsPerOccurrence.push(results.filter(Boolean).length);
        for (const [k, won] of results.entries()) if (won) await stores[k].releaseScheduleLease('a', o.now);
      }
      expect(winsPerOccurrence).to.deep.eq(new Array(N).fill(1));
      expect((await ScheduleModel.where('Name', 'a').first()).NextRunAt).to.eq(T + N * MIN);
    });

    it('a manual run claim and a scheduled claim race for one lease', async () => {
      const r1 = DI.resolve(LeaseStore, ['r1']);
      const r2 = DI.resolve(LeaseStore, ['r2']);
      const run = await queued('m1', { MaxAttempts: 1 });
      const [manual, scheduled] = await Promise.all([
        r1.claimRun(run, T),
        r2.tryClaimOccurrence({ name: 'a', expectedNextRunAt: T, nextRunAt: T + MIN, now: T }),
      ]);
      expect([manual, scheduled].filter(Boolean)).to.have.length(1);
    });

    it('three replicas race for one queued run: exactly one runs it', async () => {
      const stores = ['r1', 'r2', 'r3'].map((id) => DI.resolve(LeaseStore, [id]));
      await queued('q1', { Forced: true });
      const observed = await Promise.all(stores.map(() => RunModel.where('Id', 'q1').first()));
      const results = await Promise.all(stores.map((s, i) => s.claimRun(observed[i], T)));
      expect(results.filter(Boolean)).to.have.length(1);
      const row = await RunModel.where('Id', 'q1').first();
      expect(row).to.include({
        Status: 'running',
        LeaseOwner: stores[results.indexOf(true)].ReplicaId,
        LeaseUntil: T + stores[0].LeaseTtl,
        StartedAt: T,
      });
    });

    // MySQL counts only changed rows unless the client sets CLIENT_FOUND_ROWS (mysql2 does by
    // default); a heartbeat in the same millisecond writes identical values and must still count.
    it('a renewal that writes identical values still counts as owned', async () => {
      const r1 = DI.resolve(LeaseStore, ['r1']);
      expect(await r1.claimRun(await queued('q1'), T)).to.eq(true);
      expect(await r1.renewScheduleLease('a', T)).to.eq(true);
      expect(await r1.renewScheduleLease('a', T)).to.eq(true);
      expect(await r1.renewRun('q1', 1, 'a', T + 1000, { Progress: 10 })).to.deep.eq({
        ok: true,
        cancelRequested: false,
      });
      expect(await r1.renewRun('q1', 1, 'a', T + 1000, { Progress: 10 })).to.deep.eq({
        ok: true,
        cancelRequested: false,
      });
    });

    it('an expiry racing a late heartbeat: exactly one wins', async () => {
      const r1 = DI.resolve(LeaseStore, ['r1']);
      const r2 = DI.resolve(LeaseStore, ['r2']);
      expect(await r1.claimRun(await queued('q1'), T)).to.eq(true);
      const stale = await RunModel.where('Id', 'q1').first();
      const late = T + r1.LeaseTtl + 1;
      const [renewed, expired] = await Promise.all([
        r1.renewRun('q1', 1, null, late),
        r2.expireRun(stale, late, { status: 'retrying', reason: 'lease-expired', nextAttemptAt: late + MIN }),
      ]);
      expect([renewed.ok, expired].filter(Boolean)).to.have.length(1);
      const row = await RunModel.where('Id', 'q1').first();
      expect(row).to.include(
        expired ? { Status: 'retrying', LeaseUntil: null } : { Status: 'running', LeaseUntil: late + r1.LeaseTtl },
      );
    });

    it('an occurrence claim waiting on an uncommitted winner re-reads the row and loses', async () => {
      const r1 = DI.resolve(LeaseStore, ['r1']);
      const r2 = DI.resolve(LeaseStore, ['r2']);
      const o = { name: 'a', expectedNextRunAt: T, nextRunAt: T + MIN, now: T };
      const held = await heldOpen(() => r1.tryClaimOccurrence(o));
      expect(held.result).to.eq(true);
      expect(await losesAfterWaitingOn(held, () => r2.tryClaimOccurrence(o))).to.eq(true);
      expect(await ScheduleModel.where('Name', 'a').first()).to.include({ LeaseOwner: 'r1', NextRunAt: T + MIN });
    });

    it('a run claim waiting on an uncommitted winner re-reads the row and loses', async () => {
      const r1 = DI.resolve(LeaseStore, ['r1']);
      const r2 = DI.resolve(LeaseStore, ['r2']);
      await queued('q1', { Forced: true });
      const [mine, theirs] = await Promise.all([
        RunModel.where('Id', 'q1').first(),
        RunModel.where('Id', 'q1').first(),
      ]);
      const held = await heldOpen(() => r1.claimRun(mine, T));
      expect(held.result).to.eq(true);
      expect(await losesAfterWaitingOn(held, () => r2.claimRun(theirs, T))).to.eq(true);
      expect(await RunModel.where('Id', 'q1').first()).to.include({ Status: 'running', LeaseOwner: 'r1', Attempt: 1 });
    });

    if (target.name === 'mysql') {
      // UNIX_TIMESTAMP(NOW()) maps the session-local time back to epoch and picks the first pass of a repeated hour.
      it('reads UTC epoch inside a repeated DST hour of the session time zone', async () => {
        const driver = await defaultDriver();
        // 01:30Z is 02:30 CET, the second pass of Warsaw's repeated hour.
        const instant = Date.parse('2026-10-25T01:30:00.250Z');
        const ms = await driver.transaction(async () => {
          await driver.executeOnDb("SET time_zone = 'Europe/Warsaw'", [], QueryContext.Schema);
          await driver.executeOnDb(`SET timestamp = ${instant / 1000}`, [], QueryContext.Schema);
          try {
            return await DI.resolve(SqlDbTimeSource).read();
          } finally {
            await driver.executeOnDb('SET time_zone = DEFAULT, timestamp = DEFAULT', [], QueryContext.Schema);
          }
        });
        expect(ms).to.eq(instant);
      });
    }
  });
}
