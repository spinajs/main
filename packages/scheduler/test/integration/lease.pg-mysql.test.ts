import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import {
  Clock,
  DbTimeSource,
  defineSchedule,
  FakeClock,
  LeaseStore,
  RunAttemptModel,
  RunContext,
  RunModel,
  Scheduler,
  ScheduledTask,
  ScheduleModel,
  SqlDbTimeSource,
  undefineSchedule,
} from '../../src/index.js';
import { waitFor } from '../support/env.js';
import { deferred, driveUntil, getRun, journal, queuedRun, untilAborted } from '../support/fixtures.js';
import { bootRealDb, defaultDriver, heldOpen, REAL_DB_TARGETS } from './real-db.js';

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

let flakyCalls = 0;
let itGate = deferred();
class ItQuick extends ScheduledTask {
  public async execute() {
    return 1;
  }
}
class ItFlaky extends ScheduledTask {
  public async execute() {
    if (++flakyCalls === 1) throw new Error('first try fails');
  }
}
class ItPatient extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await untilAborted(ctx.signal);
  }
}
class ItGated extends ScheduledTask {
  public async execute() {
    await itGate.promise;
  }
}

const IT_SCHEDULES = ['it-every-second', 'it-flaky', 'it-patient', 'it-gated'];

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`scheduler integration (${target.name})`, function () {
    this.timeout(120_000);
    let clock: FakeClock;

    beforeEach(async () => {
      flakyCalls = 0;
      itGate = deferred();
      itGate.resolve();
      defineSchedule(ItQuick, 'it-every-second', { every: '1s' });
      defineSchedule(ItFlaky, 'it-flaky', { manual: true, retry: { attempts: 2, delay: '1s' } });
      defineSchedule(ItPatient, 'it-patient', { manual: true });
      await bootRealDb(target);
      clock = DI.resolve(Clock) as FakeClock;
      clock.set(Date.parse('2026-01-05T10:00:00.500Z'));
    });
    afterEach(() => IT_SCHEDULES.forEach(undefineSchedule));

    const schedulers = () =>
      Promise.all(['r1', 'r2', 'r3'].map((replicaId) => DI.resolve(Scheduler, [{ replicaId, autoStart: false }])));

    it('three schedulers: N occurrences produce exactly N runs', async () => {
      const all = await schedulers();
      const N = 10;
      for (let i = 1; i <= N; i++) {
        clock.set(Date.parse('2026-01-05T10:00:00Z') + i * 1000);
        await Promise.all(all.map((s) => s.tickOnce()));
        await Promise.all(all.map((s) => s.idle()));
      }
      const runs = await RunModel.where('Schedule', 'it-every-second');
      expect(runs).to.have.length(N);
      expect(runs.filter((r) => r.Status === 'succeeded')).to.have.length(N);
      expect(new Set(runs.map((r) => r.ScheduledAt)).size).to.eq(N);
    });

    it('a manual run racing a scheduled occurrence: exactly one of them runs at a time', async () => {
      itGate = deferred();
      defineSchedule(ItGated, 'it-gated', { every: '1s' });
      const all = await schedulers();
      const manual = await queuedRun('it-gated', clock.now());
      clock.set(Date.parse('2026-01-05T10:00:01Z'));
      await Promise.all(all.map((s) => s.tickOnce()));

      const during = await RunModel.where('Schedule', 'it-gated');
      const running = during.filter((r) => r.Status === 'running');
      expect(running, 'runs holding the schedule').to.have.length(1);
      const occurrence = during.filter((r) => r.Trigger === 'schedule');
      expect(occurrence, 'the occurrence is decided once').to.have.length(1);
      // the loser waits (manual run) or is recorded as an overlap (occurrence)
      if (running[0].Id === manual.Id) expect(occurrence[0]).to.include({ Status: 'skipped', Reason: 'overlap' });
      else expect(during.find((r) => r.Id === manual.Id)).to.include({ Status: 'queued' });

      itGate.resolve();
      await Promise.all(all.map((s) => s.idle()));
      await Promise.all(all.map((s) => s.tickOnce()));
      await Promise.all(all.map((s) => s.idle()));
      expect(await getRun(manual.Id)).to.include({ Status: 'succeeded' });
      expect((await RunModel.where('Schedule', 'it-gated')).filter((r) => r.Status === 'running')).to.have.length(0);
    });

    it('a killed holder: the lease expires and the retry runs on another replica', async () => {
      const [, r2] = await schedulers();
      const run = await queuedRun('it-flaky', clock.now(), { MaxAttempts: 2 });
      // what the killed replica did before it died: claimed the run and started attempt 1
      const killed = DI.resolve(LeaseStore, ['killed']);
      expect(await killed.claimRun(run, clock.now())).to.eq(true);
      await RunAttemptModel.create({ RunId: run.Id, Attempt: 1, StartedAt: clock.now(), Status: 'running' });
      flakyCalls = 1;

      await r2.tickOnce();
      expect((await getRun(run.Id)).Status, 'the lease is still valid').to.eq('running');

      clock.set(clock.now() + killed.LeaseTtl + 1);
      await r2.tickOnce();
      expect(await getRun(run.Id)).to.include({ Status: 'retrying', Reason: 'lease-expired', LeaseOwner: null });
      clock.set(clock.now() + 1000);
      await r2.tickOnce();
      await r2.idle();
      expect(await getRun(run.Id)).to.include({ Status: 'succeeded', Attempt: 2 });
      const attempts = await RunAttemptModel.where('RunId', run.Id).orderBy('Attempt');
      expect(attempts.map((a) => [a.Attempt, a.Status])).to.deep.eq([
        [1, 'failed'],
        [2, 'succeeded'],
      ]);
      expect(attempts[0].Error).to.include({ name: 'RunAbortedError', attempt: 1 });
    });

    it('a lost lease aborts the run on the old holder, which then writes nothing', async () => {
      const [r1] = await schedulers();
      const run = await queuedRun('it-patient', clock.now());
      await r1.tickOnce();
      expect(r1.isRunningLocally(run.Id)).to.eq(true);
      await waitFor(async () => (await journal(run.Id)).length > 0);
      await RunModel.update({ LeaseOwner: 'thief' }).where('Id', run.Id);
      const before = await journal(run.Id);
      await driveUntil(clock, r1.idle(), 5000);
      expect(await getRun(run.Id)).to.include({ Status: 'running', LeaseOwner: 'thief' });
      expect(r1.isRunningLocally(run.Id)).to.eq(false);
      expect(await journal(run.Id)).to.have.length(before.length);
    });

    it('uses database time when the replica clock is wrong', async () => {
      clock.set(Date.parse('2020-01-01T00:00:00Z'));
      // A factory, not the class: SqlDbTimeSource is already registered by its decorator, so registering
      // the class again keeps it behind bootTestEnv's fake source. DbClock is resolved after this line.
      DI.register(() => new SqlDbTimeSource()).as(DbTimeSource);
      const [r1] = await schedulers();
      const next = (await ScheduleModel.where('Name', 'it-every-second').first()).NextRunAt;
      expect(Math.abs((next ?? 0) - Date.now())).to.be.lessThan(10_000);
      // the first occurrence was computed from real database time when the scheduler booted
      await new Promise((r) => setTimeout(r, 1100));
      await r1.tickOnce();
      await r1.idle();
      const run = await RunModel.where('Schedule', 'it-every-second').orderByDescending('CreatedAt').first();
      expect(run, 'an occurrence fired on database time').to.not.eq(undefined);
      expect(run.Status).to.eq('succeeded');
      expect(Math.abs(run.CreatedAt - Date.now())).to.be.lessThan(10_000);
    });
  });
}
