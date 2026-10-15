import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import {
  defineSchedule,
  ErrorGroupModel,
  FakeClock,
  HealthTracker,
  healthOf,
  RunFinalizer,
  RunContext,
  RunModel,
  Scheduler,
  SchedulerSignals,
  ScheduledTask,
  ScheduleModel,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import { driveUntil, getRun, queuedRun, untilAborted } from './support/fixtures.js';

let fail = true;
class HealthToggleTask extends ScheduledTask {
  public execute() {
    return fail ? Promise.reject(new Error('down')) : Promise.resolve();
  }
}
const row = (name: string) => ScheduleModel.where('Name', name).first();

describe('health and auto-pause', () => {
  let clock: FakeClock;
  let s: Scheduler;
  const runOnce = async (name: string) => {
    await queuedRun(name, clock.now());
    await s.tickOnce();
    await s.idle();
  };

  beforeEach(async () => {
    fail = true;
    defineSchedule(HealthToggleTask, 'fragile', { manual: true, pauseAfterFailures: 2 });
    defineSchedule(HealthToggleTask, 'retried', { manual: true, retry: { attempts: 2, delay: '1s' } });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
  });
  afterEach(() => {
    ['fragile', 'retried'].forEach(undefineSchedule);
    sinon.restore();
  });

  it('derives health from the row', () => {
    expect(healthOf({ Paused: false, PausedReason: null, ConsecutiveFailures: 0 })).to.eq('ok');
    expect(healthOf({ Paused: false, PausedReason: null, ConsecutiveFailures: 2 })).to.eq('failing');
    expect(healthOf({ Paused: true, PausedReason: 'failures', ConsecutiveFailures: 2 })).to.eq('paused-by-failures');
    expect(healthOf({ Paused: true, PausedReason: 'manual', ConsecutiveFailures: 0 })).to.eq('ok');
  });

  it('counts consecutive failures, auto-pauses, and resets on success', async () => {
    const paused = sinon.spy(SchedulerSignals.prototype, 'pausedByFailures');
    const health = sinon.spy(SchedulerSignals.prototype, 'healthChanged');
    await runOnce('fragile');
    expect(await row('fragile')).to.include({ ConsecutiveFailures: 1, Paused: false });
    await runOnce('fragile');
    expect(await row('fragile')).to.include({ ConsecutiveFailures: 2, Paused: true, PausedReason: 'failures' });
    expect(paused.calledOnceWith('fragile', 2)).to.eq(true);
    fail = false;
    await runOnce('fragile');
    expect(await row('fragile')).to.include({ ConsecutiveFailures: 0, LastSuccessAt: clock.now() });
    expect(health.args).to.deep.eq([
      ['fragile', 1],
      ['fragile', 2],
      ['fragile', 0],
    ]);
  });

  it('does not count an attempt that will be retried', async () => {
    await queuedRun('retried', clock.now(), { MaxAttempts: 2 });
    await s.tickOnce();
    await s.idle();
    expect((await row('retried')).ConsecutiveFailures).to.eq(0);
    clock.set(clock.now() + 1000);
    await s.tickOnce();
    await s.idle();
    expect((await row('retried')).ConsecutiveFailures).to.eq(1);
  });

  describe('HealthTracker', () => {
    const T = Date.parse('2026-01-05T10:00:00Z');
    let tracker: HealthTracker;

    beforeEach(() => {
      tracker = DI.resolve(HealthTracker);
    });

    it('counts every concurrent failure and pauses exactly once', async () => {
      const results = await Promise.all([1, 2, 3, 4, 5].map((i) => tracker.recordFailure('fragile', 3, T + i)));
      expect(await row('fragile')).to.include({ ConsecutiveFailures: 5, Paused: true, PausedReason: 'failures' });
      expect(results.filter((r) => r.paused)).to.have.length(1);
    });

    it('does not turn a manual pause into a pause by failures', async () => {
      await ScheduleModel.update({ Paused: true, PausedReason: 'manual' }).where('Name', 'fragile');
      const r = await tracker.recordFailure('fragile', 1, T);
      expect(r).to.deep.eq({ consecutive: 1, paused: false });
      expect(await row('fragile')).to.include({ Paused: true, PausedReason: 'manual' });
    });

    it('never pauses without a threshold and ignores unknown schedules', async () => {
      for (let i = 0; i < 3; i++) await tracker.recordFailure('retried', undefined, T + i);
      expect(await row('retried')).to.include({ ConsecutiveFailures: 3, Paused: false });
      expect(await tracker.recordFailure('nope', 1, T)).to.deep.eq({ consecutive: 0, paused: false });
    });
  });

  it('does not count a cancelled run, and still finishes the run when health tracking fails', async () => {
    const finalizer = DI.resolve(RunFinalizer);
    const run = { Id: 'x1', Schedule: 'fragile', Attempt: 1, StartedAt: clock.now(), Trigger: 'manual' } as RunModel;
    await finalizer.finalized({ run, status: 'aborted', error: null, now: clock.now(), countsAsFailure: false });
    expect((await row('fragile')).ConsecutiveFailures).to.eq(0);

    sinon.stub(HealthTracker.prototype, 'recordFailure').rejects(new Error('db down'));
    const finished = sinon.spy(SchedulerSignals.prototype, 'runFinished');
    await finalizer.finalized({ run, status: 'failed', error: null, now: clock.now(), countsAsFailure: true });
    expect(finished.calledOnce).to.eq(true);
  });
});

class HealthHangTask extends ScheduledTask {
  public execute(ctx: RunContext) {
    return untilAborted(ctx.signal);
  }
}

describe('health and error groups of aborted runs', () => {
  let clock: FakeClock;
  let s: Scheduler;
  const NAMES = ['hang', 'hang-timeout'];
  const groups = () => ErrorGroupModel.query().whereIn('Schedule', NAMES);

  beforeEach(async () => {
    defineSchedule(HealthHangTask, 'hang', { manual: true, pauseAfterFailures: 1 });
    defineSchedule(HealthHangTask, 'hang-timeout', { manual: true, timeout: '5s', pauseAfterFailures: 2 });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    // neutral endings must neither count nor reset an existing streak
    await ScheduleModel.update({ ConsecutiveFailures: 1 }).where('Name', 'hang');
  });
  afterEach(() => NAMES.forEach(undefineSchedule));

  it('a shutdown with no retry left is neither counted nor grouped', async () => {
    const run = await queuedRun('hang', clock.now());
    await s.tickOnce();
    await s.stop();
    expect(await getRun(run.Id)).to.include({ Status: 'aborted', Reason: 'shutdown' });
    expect(await row('hang')).to.include({ ConsecutiveFailures: 1, Paused: false });
    expect(await groups()).to.have.length(0);
  });

  it('a cancelled run is neither counted nor grouped', async () => {
    const run = await queuedRun('hang', clock.now());
    await s.tickOnce();
    await waitFor(async () => (await getRun(run.Id)).Status === 'running');
    await RunModel.update({ CancelRequested: true }).where('Id', run.Id);
    await driveUntil(clock, s.idle());
    expect(await getRun(run.Id)).to.include({ Status: 'aborted', Reason: 'cancelled' });
    expect(await row('hang')).to.include({ ConsecutiveFailures: 1, Paused: false });
    expect(await groups()).to.have.length(0);
  });

  it('an expired lease is grouped but not counted', async () => {
    const ghost = await queuedRun('hang', clock.now(), {
      Status: 'running',
      LeaseOwner: 'dead-replica',
      LeaseUntil: clock.now() - 1,
      StartedAt: clock.now() - 120_000,
    });
    await s.tickOnce();
    await s.idle();
    expect(await getRun(ghost.Id)).to.include({ Status: 'aborted', Reason: 'lease-expired' });
    expect(await row('hang')).to.include({ ConsecutiveFailures: 1, Paused: false });
    const [g] = await groups();
    expect(g).to.include({ Name: 'RunAbortedError', Count: 1, LastRunId: ghost.Id });
  });

  it('a timeout is counted and grouped', async () => {
    const run = await queuedRun('hang-timeout', clock.now());
    await s.tickOnce();
    await driveUntil(clock, s.idle());
    expect(await getRun(run.Id)).to.include({ Status: 'aborted', Reason: 'timeout' });
    expect(await row('hang-timeout')).to.include({ ConsecutiveFailures: 1, Paused: false });
    expect((await groups()).map((g) => g.SampleMessage)).to.deep.eq(['Run aborted: timeout']);
  });
});
