import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { defineSchedule, RunModel, Scheduler, ScheduledTask, ScheduleModel, undefineSchedule } from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import { deferred, getRun, queuedRun } from './support/fixtures.js';

let gate = deferred();
class LocalWork extends ScheduledTask {
  public async execute() {
    await gate.promise;
  }
}
class LocalFails extends ScheduledTask {
  public async execute() {
    await Promise.resolve();
    throw new Error('cache backend down');
  }
}

describe('Scheduler: runOn all', () => {
  beforeEach(() => {
    gate = deferred();
    defineSchedule(LocalWork, 'local-cache', { every: '1m', runOn: 'all' });
  });
  afterEach(() => ['local-cache', 'local-flaky'].forEach(undefineSchedule));

  it('runs on every replica and records each run', async () => {
    gate.resolve();
    const { clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' });
    const all = await Promise.all(
      ['r1', 'r2', 'r3'].map((replicaId) => DI.resolve(Scheduler, [{ replicaId, autoStart: false }])),
    );
    await Promise.all(all.map((s) => s.tickOnce()));
    clock.set('2026-01-05T10:01:00Z');
    await Promise.all(all.map((s) => s.tickOnce()));
    await Promise.all(all.map((s) => s.idle()));
    const runs = await RunModel.where('Schedule', 'local-cache');
    expect(runs.map((r) => r.Status)).to.deep.eq(['succeeded', 'succeeded', 'succeeded']);
    expect(runs.every((r) => r.Forced)).to.eq(true);
    expect(runs.every((r) => r.ScheduledAt === Date.parse('2026-01-05T10:01:00Z'))).to.eq(true);
    expect((await ScheduleModel.where('Name', 'local-cache').first()).NextRunAt).to.eq(null);
  });

  it('skips locally while the previous local run is still going', async () => {
    const { clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' });
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    await s.tickOnce();
    clock.set('2026-01-05T10:01:00Z');
    await s.tickOnce();
    clock.set('2026-01-05T10:02:00Z');
    await s.tickOnce();
    expect((await RunModel.where('Schedule', 'local-cache').orderBy('CreatedAt')).map((r) => r.Status)).to.deep.eq([
      'running',
      'skipped',
    ]);
    gate.resolve();
    await s.idle();
  });

  it('does not catch up after downtime: the next local run is the first after now', async () => {
    gate.resolve();
    const { clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' });
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    await s.tickOnce();
    clock.set('2026-01-05T10:05:30Z');
    await s.tickOnce();
    await s.idle();
    clock.set('2026-01-05T10:06:00Z');
    await s.tickOnce();
    await s.idle();
    const runs = await RunModel.where('Schedule', 'local-cache').orderBy('CreatedAt');
    expect(runs.map((r) => new Date(r.ScheduledAt!).toISOString())).to.deep.eq([
      '2026-01-05T10:01:00.000Z',
      '2026-01-05T10:06:00.000Z',
    ]);
  });

  it('wakes up for the next local occurrence instead of waiting a whole tick', async () => {
    gate.resolve();
    const { clock } = await bootTestEnv({ now: '2026-01-05T10:00:59.900Z', scheduler: { tick: 30_000 } });
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1' }]);
    // the first tick at boot plans 10:01:00; the timer must fire then, not 30 s later
    await clock.advance(0);
    await waitFor(() => (s as unknown as { lastTickAt?: number }).lastTickAt !== undefined);
    // fake time moves at most 1 s; past that only timers already due fire
    const budget = clock.now() + 1000;
    await waitFor(async () => {
      await clock.advance(clock.now() < budget ? 50 : 0);
      return (await RunModel.where('Schedule', 'local-cache')).length === 1;
    }, 10_000);
    await s.stop();
  });

  it('does not fire while the schedule is paused or orphaned', async () => {
    gate.resolve();
    const { clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' });
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    await s.tickOnce();
    await ScheduleModel.update({ Paused: true }).where('Name', 'local-cache');
    clock.set('2026-01-05T10:01:00Z');
    await s.tickOnce();
    await ScheduleModel.update({ Paused: false, Orphaned: true }).where('Name', 'local-cache');
    clock.set('2026-01-05T10:02:00Z');
    await s.tickOnce();
    expect(await RunModel.where('Schedule', 'local-cache')).to.have.length(0);

    await ScheduleModel.update({ Orphaned: false }).where('Name', 'local-cache');
    clock.set('2026-01-05T10:03:00Z');
    await s.tickOnce();
    await s.idle();
    // occurrences that came due while paused are dropped, not fired late
    const runs = await RunModel.where('Schedule', 'local-cache');
    expect(runs.map((r) => [r.Status, r.ScheduledAt])).to.deep.eq([['succeeded', Date.parse('2026-01-05T10:03:00Z')]]);
  });

  it('does not retry a local run automatically, so no other replica can claim it', async () => {
    gate.resolve();
    defineSchedule(LocalFails, 'local-flaky', { every: '1m', runOn: 'all', retry: { attempts: 3, delay: '1s' } });
    const { clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' });
    const [r1, r2] = await Promise.all(
      ['r1', 'r2'].map((replicaId) => DI.resolve(Scheduler, [{ replicaId, autoStart: false }])),
    );
    await r1.tickOnce();
    clock.set('2026-01-05T10:01:00Z');
    await r1.tickOnce();
    await r1.idle();
    const [run] = await RunModel.where('Schedule', 'local-flaky');
    expect(run).to.include({ Status: 'failed', MaxAttempts: 1, NextAttemptAt: null, LeaseOwner: null });

    // a local run of a replica that died is not retried elsewhere either
    const ghost = await queuedRun('local-flaky', clock.now(), {
      Status: 'running',
      Forced: true,
      LeaseOwner: 'gone',
      LeaseUntil: clock.now() - 1,
      StartedAt: clock.now() - 120_000,
      MaxAttempts: 3,
    });
    clock.set('2026-01-05T10:01:30Z');
    await r2.tickOnce();
    await r2.idle();
    expect(await getRun(ghost.Id)).to.include({ Status: 'aborted', Reason: 'lease-expired', NextAttemptAt: null });
  });
});
