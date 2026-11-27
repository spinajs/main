import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  DefinitionSync,
  defineSchedule,
  emitJobId,
  HealthTracker,
  LeaseStore,
  RunModel,
  runJobId,
  runsOf,
  scheduleKey,
  Scheduler,
  ScheduledTask,
  SchedulerService,
  ScheduleModel,
  undefineSchedule,
} from '../src/index.js';
import type { FakeClock } from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { deferred, makeDef, queuedRun } from './support/fixtures.js';

const T = Date.parse('2026-01-05T10:00:00Z');
const MIN = 60_000;
const ACME = { name: 'a', tenant: 'acme' };
const at = (time: string) => Date.parse(`2026-01-05T${time}:00Z`);

const seed = (name: string, tenant: string, extra: Partial<ScheduleModel> = {}): Promise<ScheduleModel> =>
  ScheduleModel.create({
    Name: name,
    Tenant: tenant,
    Definition: {},
    DefinitionHash: 'h',
    NextRunAt: T,
    Paused: false,
    HardPaused: false,
    ConsecutiveFailures: 0,
    Orphaned: false,
    UpdatedAt: T,
    ...extra,
  });
const rowOf = (name: string, tenant: string): Promise<ScheduleModel> =>
  ScheduleModel.where({ Name: name, Tenant: tenant }).first();

let gate = deferred();
class Quick extends ScheduledTask {
  public execute() {
    return Promise.resolve('done');
  }
}
class Held extends ScheduledTask {
  public async execute() {
    await gate.promise;
  }
}

describe('schedule instances', () => {
  describe('LeaseStore and HealthTracker', () => {
    let r1: LeaseStore;
    let r2: LeaseStore;

    beforeEach(async () => {
      await bootTestEnv();
      await seed('a', '');
      await seed('a', 'acme');
      r1 = DI.resolve(LeaseStore, ['r1']);
      r2 = DI.resolve(LeaseStore, ['r2']);
    });

    it('claims the occurrence of one instance and leaves the other due', async () => {
      expect(
        await r1.tryClaimOccurrence({ name: 'a', tenant: 'acme', expectedNextRunAt: T, nextRunAt: T + MIN, now: T }),
      ).to.eq(true);
      expect(await rowOf('a', 'acme')).to.include({ NextRunAt: T + MIN, LeaseOwner: 'r1' });
      expect(await rowOf('a', '')).to.include({ NextRunAt: T, LeaseOwner: null });
      expect(await r2.tryClaimOccurrence({ name: 'a', expectedNextRunAt: T, nextRunAt: T + MIN, now: T })).to.eq(true);
    });

    it('takes, renews and releases the lease of each instance on its own', async () => {
      expect(await r1.takeScheduleLease(ACME, T)).to.eq('free');
      expect(await r2.takeScheduleLease('a', T)).to.eq('free');
      expect(await r2.takeScheduleLease(ACME, T + 1)).to.eq(false);
      expect(await r1.renewScheduleLease(ACME, T + 2)).to.eq(true);
      expect(await r1.releaseScheduleLease('a', T + 3)).to.eq(false);
      expect(await r1.releaseScheduleLease(ACME, T + 3)).to.eq(true);
      expect(await rowOf('a', '')).to.include({ LeaseOwner: 'r2' });
    });

    it('claims and heartbeats a run under the lease of its own instance', async () => {
      await r2.takeScheduleLease('a', T);
      const run = await queuedRun('a', T, { Tenant: 'acme' });

      expect(await r1.claimRun(run, T)).to.eq(true);
      expect(await rowOf('a', 'acme')).to.include({ LeaseOwner: 'r1' });
      expect(await r1.renewRun(run.Id, run.Attempt, ACME, T + MIN)).to.deep.eq({ ok: true, cancelRequested: false });
      expect(await rowOf('a', 'acme')).to.include({ LeaseUntil: T + 2 * MIN });
      expect(await rowOf('a', '')).to.include({ LeaseOwner: 'r2', LeaseUntil: T + MIN });
    });

    it('records the last run, the failures and the pause of each instance on its own', async () => {
      const health = DI.resolve(HealthTracker);
      await r1.recordLast(ACME, T, 'failed', 'run-1');
      expect(await health.recordFailure(ACME, 2, T)).to.deep.eq({ consecutive: 1, paused: false });
      expect(await health.recordFailure(ACME, 2, T)).to.deep.eq({ consecutive: 2, paused: true });
      expect(await rowOf('a', 'acme')).to.include({
        LastRunId: 'run-1',
        LastStatus: 'failed',
        Paused: true,
        PausedReason: 'failures',
      });
      expect(await rowOf('a', '')).to.include({ LastRunId: null, ConsecutiveFailures: 0, Paused: false });
      await health.recordSuccess(ACME, T);
      expect((await rowOf('a', 'acme')).ConsecutiveFailures).to.eq(0);
    });

    it('finds the runs of the global instance by a NULL tenant and never those of a tenant', async () => {
      const globalRun = await queuedRun('a', T);
      const acme = await queuedRun('a', T, { Tenant: 'acme' });
      const ids = async (key: { name: string; tenant: string }) =>
        (await RunModel.query().where(runsOf(key))).map((r) => r.Id);

      expect(await ids(scheduleKey('a'))).to.deep.eq([globalRun.Id]);
      expect(await ids(ACME)).to.deep.eq([acme.Id]);
      expect(await RunModel.where({ Schedule: 'a', Tenant: '' })).to.have.length(0);
    });

    it('syncs definitions into the global rows only and leaves the tenant rows alone', async () => {
      const sync = DI.resolve(DefinitionSync);
      await sync.sync([makeDef('a', { every: '5m' }, Quick)], T);
      expect(await rowOf('a', 'acme')).to.include({ DefinitionHash: 'h', Orphaned: false });
      expect((await rowOf('a', '')).DefinitionHash).to.not.eq('h');

      await sync.sync([], T);
      expect(await rowOf('a', '')).to.include({ Orphaned: true });
      expect(await rowOf('a', 'acme')).to.include({ Orphaned: false });
    });
  });

  describe('job ids of emit mode', () => {
    it('keeps the id of a global run and gives every tenant of one occurrence its own', () => {
      expect(emitJobId('digest', T, null)).to.eq(emitJobId('digest', T));
      expect(emitJobId('digest', T, 'acme')).to.not.eq(emitJobId('digest', T));
      expect(emitJobId('digest', T, 'acme')).to.not.eq(emitJobId('digest', T, 'globex'));
      const run = { Id: 'r', Schedule: 'digest', Trigger: 'schedule' as const, ScheduledAt: T };
      expect(runJobId({ ...run, Tenant: 'acme' })).to.eq(emitJobId('digest', T, 'acme'));
      expect(runJobId(run)).to.eq(emitJobId('digest', T));
    });
  });

  describe('the loop and the service', () => {
    let clock: FakeClock;
    const scheduler = (): Promise<Scheduler> => DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    const runsOfSchedule = async (name: string) =>
      (await RunModel.where('Schedule', name)).map((r) => [r.Tenant, r.Status]);

    beforeEach(async () => {
      gate = deferred();
      defineSchedule(Quick, 'per-instance', { every: '1m' });
      defineSchedule(Held, 'held', { every: '1m' });
      ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' }));
    });

    afterEach(() => {
      gate.resolve();
      ['per-instance', 'held'].forEach(undefineSchedule);
    });

    it('fires every due instance of a schedule, each run naming its tenant', async () => {
      // the global `held` instance is due at 10:01 too; with the gate open its run ends and idle() returns
      gate.resolve();
      const s = await scheduler();
      await seed('per-instance', 'acme', { NextRunAt: at('10:01') });
      clock.set('2026-01-05T10:01:00Z');

      await s.tickOnce();
      await s.idle();

      expect(await runsOfSchedule('per-instance')).to.have.deep.members([
        [null, 'succeeded'],
        ['acme', 'succeeded'],
      ]);
      const acme = await RunModel.where({ Schedule: 'per-instance', Tenant: 'acme' }).first();
      expect(await rowOf('per-instance', 'acme')).to.include({
        NextRunAt: at('10:02'),
        LastStatus: 'succeeded',
        LastRunId: acme.Id,
      });
    });

    it('starts one instance while another instance of the schedule is still running', async () => {
      const s = await scheduler();
      await ScheduleModel.update({ Paused: true }).where({ Name: 'held', Tenant: '' });
      await seed('held', 'acme', { NextRunAt: at('10:01') });
      clock.set('2026-01-05T10:01:00Z');
      await s.tickOnce();

      await ScheduleModel.update({ Paused: false, NextRunAt: at('10:02') }).where({ Name: 'held', Tenant: '' });
      clock.set('2026-01-05T10:02:00Z');
      await s.tickOnce();

      expect(await runsOfSchedule('held')).to.have.deep.members([
        ['acme', 'running'],
        ['acme', 'skipped'],
        [null, 'running'],
      ]);
      gate.resolve();
      await s.idle();
    });

    it('pauses, resumes and prunes the global instance by its name and leaves the tenant rows alone', async () => {
      await scheduler();
      const service = await DI.resolve(SchedulerService);
      const by = { triggeredBy: { kind: 'user' as const, id: '1' } };
      await seed('per-instance', 'acme', { Paused: true, PausedReason: 'manual' });
      await seed('gone', '', { Orphaned: true });
      await seed('gone', 'acme', { Orphaned: true });

      await service.pause('per-instance', by);
      expect(await rowOf('per-instance', '')).to.include({ Paused: true });
      await service.resume('per-instance', by);
      expect(await rowOf('per-instance', '')).to.include({ Paused: false });
      expect(await rowOf('per-instance', 'acme')).to.include({ Paused: true, PausedReason: 'manual' });

      expect((await service.prune(by)).orphanedSchedules).to.eq(2);
      expect(await ScheduleModel.where('Name', 'gone')).to.have.length(0);
    });

    it('stores a run of the global instance with a NULL tenant whatever encoding it was given', async () => {
      await scheduler();
      const service = await DI.resolve(SchedulerService);
      const parent = await queuedRun('per-instance', T, { Status: 'failed', Tenant: '' });
      const { runId } = await service.retry(parent.Id, { triggeredBy: { kind: 'user', id: '1' } });
      expect((await RunModel.where('Id', runId).first()).Tenant).to.eq(null);
    });
  });
});
