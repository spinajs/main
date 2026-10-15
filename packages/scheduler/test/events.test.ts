import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { BlackHoleQueueClient, DefaultQueueService } from '@spinajs/queue';
import {
  AbortReason,
  defineSchedule,
  ErrorGroupModel,
  FakeClock,
  RunContext,
  RunFinalizer,
  RunModel,
  Scheduler,
  SchedulerSignals,
  ScheduledTask,
  StructuredError,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { driveUntil, getRun, queuedRun, untilAborted } from './support/fixtures.js';

let fail = false;
class EventsToggleTask extends ScheduledTask {
  public async execute() {
    if (fail) throw new Error('down');
  }
}
class EventsHangTask extends ScheduledTask {
  public execute(ctx: RunContext) {
    return untilAborted(ctx.signal);
  }
}

const NAMES = ['ev-plain', 'ev-retry', 'ev-hang', 'ev-timeout'];
// sends are fire-and-forget; tests wait for them before reading what was sent
const sent = () => DI.resolve(SchedulerSignals).drain();

describe('scheduler events', () => {
  let clock: FakeClock;
  let s: Scheduler;
  let emitted: Array<Record<string, unknown>>;
  const names = () => emitted.map((e) => e.Name);
  const named = (n: string) => emitted.filter((e) => e.Name === n);
  const run = async (name: string, extra = {}) => {
    const r = await queuedRun(name, clock.now(), extra);
    await s.tickOnce();
    await s.idle();
    await sent();
    return r;
  };

  beforeEach(async () => {
    fail = false;
    emitted = [];
    sinon
      .stub(DefaultQueueService.prototype, 'emit')
      .callsFake(async (e: unknown) => void emitted.push(e as Record<string, unknown>));
    defineSchedule(EventsToggleTask, 'ev-plain', { manual: true, pauseAfterFailures: 1 });
    defineSchedule(EventsToggleTask, 'ev-retry', { manual: true, retry: { attempts: 2, delay: '1s' } });
    defineSchedule(EventsHangTask, 'ev-hang', { manual: true });
    defineSchedule(EventsHangTask, 'ev-timeout', { manual: true, timeout: '5s' });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
  });
  afterEach(() => {
    sinon.restore();
    NAMES.forEach(undefineSchedule);
  });

  it('emits started and succeeded', async () => {
    const r = await run('ev-plain', { ScheduledAt: clock.now() });
    expect(names()).to.deep.eq(['ScheduleRunStarted', 'ScheduleRunSucceeded']);
    expect(emitted[0]).to.include({
      Type: 'EVENT',
      Schedule: 'ev-plain',
      RunId: r.Id,
      Trigger: 'manual',
      Attempt: 1,
      ScheduledAt: '2026-01-05T10:00:00.000Z',
    });
    expect(emitted[1]).to.include({ Schedule: 'ev-plain', RunId: r.Id, Attempt: 1, DurationMs: 0 });
  });

  it('emits retrying, then failed and dead', async () => {
    fail = true;
    const r = await run('ev-retry', { MaxAttempts: 2 });
    clock.set(clock.now() + 1000);
    await s.tickOnce();
    await s.idle();
    await sent();
    expect(names()).to.deep.eq([
      'ScheduleRunStarted',
      'ScheduleRetrying',
      'ScheduleRunStarted',
      'ScheduleRunFailed',
      'ScheduleDead',
    ]);
    expect(emitted[1]).to.include({ RunId: r.Id, Attempt: 1, NextAttemptAt: '2026-01-05T10:00:01.000Z' });
    expect((emitted[1].Error as StructuredError).message).to.eq('down');
    expect(emitted[3]).to.include({ RunId: r.Id, Attempt: 2, Status: 'dead' });
    expect(emitted[3].Error).to.include({ name: 'Error', message: 'down', attempt: 2 });
    expect(emitted[4]).to.include({ RunId: r.Id, Attempts: 2 });
  });

  it('emits failed, then paused-by-failures', async () => {
    fail = true;
    const r = await run('ev-plain');
    expect(names()).to.deep.eq(['ScheduleRunStarted', 'ScheduleRunFailed', 'SchedulePausedByFailures']);
    expect(named('ScheduleRunFailed')[0]).to.include({ RunId: r.Id, Attempt: 1, Status: 'failed' });
    expect(named('SchedulePausedByFailures')[0]).to.include({ Schedule: 'ev-plain', ConsecutiveFailures: 1 });
    expect(names()).to.not.include('ScheduleDead');
  });

  it('emits a regression when a resolved error comes back', async () => {
    fail = true;
    await run('ev-retry', { MaxAttempts: 1 });
    const [group] = await ErrorGroupModel.where('Schedule', 'ev-retry');
    await ErrorGroupModel.update({ Status: 'resolved' }).where('Id', group.Id);
    emitted.length = 0;
    const r = await run('ev-retry', { MaxAttempts: 1 });
    expect(names()).to.deep.eq(['ScheduleRunStarted', 'ScheduleRunFailed', 'ScheduleDead', 'ScheduleErrorRegressed']);
    const [ev] = named('ScheduleErrorRegressed');
    expect(ev).to.include({ Schedule: 'ev-retry', RunId: r.Id, Fingerprint: group.Fingerprint });
    expect((ev.Error as StructuredError).message).to.eq('down');
  });

  it('emits failed for a timeout but not for a shutdown', async () => {
    const timedOut = await queuedRun('ev-timeout', clock.now());
    await s.tickOnce();
    await driveUntil(clock, s.idle());
    await sent();
    expect(await getRun(timedOut.Id)).to.include({ Status: 'aborted', Reason: 'timeout' });
    expect(named('ScheduleRunFailed')).to.have.length(1);
    expect(named('ScheduleRunFailed')[0]).to.include({ RunId: timedOut.Id, Status: 'aborted' });

    emitted.length = 0;
    const stopped = await queuedRun('ev-hang', clock.now());
    await s.tickOnce();
    await s.stop();
    await sent();
    expect(await getRun(stopped.Id)).to.include({ Status: 'aborted', Reason: 'shutdown' });
    expect(names()).to.deep.eq(['ScheduleRunStarted']);
  });

  it('emits failed exactly when the finalizer counts the run as a failure', async () => {
    const finalizer = DI.resolve(RunFinalizer);
    const reasons: AbortReason[] = ['cancelled', 'shutdown', 'lease-lost', 'lease-expired', 'timeout'];
    for (const reason of reasons) {
      const r = { Id: `x-${reason}`, Schedule: 'ev-hang', Attempt: 1, Trigger: 'manual', Reason: reason } as RunModel;
      await finalizer.finalized({
        run: r,
        status: 'aborted',
        error: null,
        now: clock.now(),
        countsAsFailure: reason === 'timeout',
      });
    }
    // the caller's decision wins: signals do not re-derive it from the reason
    const odd = { Id: 'x-flagged', Schedule: 'ev-hang', Attempt: 1, Trigger: 'manual', Reason: 'shutdown' } as RunModel;
    await finalizer.finalized({ run: odd, status: 'aborted', error: null, now: clock.now(), countsAsFailure: true });
    await sent();
    expect(named('ScheduleRunFailed').map((e) => e.RunId)).to.deep.eq(['x-timeout', 'x-flagged']);
  });

  it('emits retrying before a regression of the same attempt', async () => {
    fail = true;
    await run('ev-retry', { MaxAttempts: 1 });
    await ErrorGroupModel.update({ Status: 'resolved' }).where('Schedule', 'ev-retry');
    emitted.length = 0;
    await run('ev-retry', { MaxAttempts: 2 });
    expect(names()).to.deep.eq(['ScheduleRunStarted', 'ScheduleRetrying', 'ScheduleErrorRegressed']);
  });

  it('reports the queue attempts of a dead emit-mode run', async () => {
    const r = { Id: 'x-emit', Schedule: 'ev-plain', Attempt: 1, Trigger: 'manual', JobId: 'job-1' } as RunModel;
    const error: StructuredError = {
      name: 'QueueJobFailedError',
      message: 'boom',
      attempt: 1,
      occurredAt: '2026-01-05T10:00:00.000Z',
      data: { attempt: 3, maxAttempts: 3 },
    };
    await DI.resolve(RunFinalizer).finalized({
      run: r,
      status: 'dead',
      error,
      now: clock.now(),
      countsAsFailure: true,
    });
    await sent();
    expect(named('ScheduleDead')[0]).to.include({ RunId: 'x-emit', Attempts: 3 });
  });

  it('never fails a run because an event could not be sent', async () => {
    (DefaultQueueService.prototype.emit as sinon.SinonStub).rejects(new Error('broker down'));
    const r = await run('ev-plain');
    expect((await getRun(r.Id)).Status).to.eq('succeeded');
    fail = true;
    const f = await run('ev-plain');
    expect((await getRun(f.Id)).Status).to.eq('failed');
  });

  it('never waits for a send that does not settle', async () => {
    (DefaultQueueService.prototype.emit as sinon.SinonStub).callsFake(() => new Promise(() => undefined));
    const r = await queuedRun('ev-plain', clock.now());
    await s.tickOnce();
    await s.idle();
    expect((await getRun(r.Id)).Status).to.eq('succeeded');
    fail = true;
    const f = await queuedRun('ev-retry', clock.now(), { MaxAttempts: 2 });
    await s.tickOnce();
    await s.idle();
    expect((await getRun(f.Id)).Status).to.eq('retrying');

    // stop() drains pending sends, bounded by min(shutdownGrace, 5 s); the test env uses 2 s
    const started = Date.now();
    await s.stop();
    expect(Date.now() - started).to.be.lessThan(4000);
  });
});

describe('scheduler event routing', () => {
  afterEach(() => {
    sinon.restore();
    undefineSchedule('ev-routed');
  });

  it('sends every event to the scheduler black-hole connection by default', async () => {
    const connections: string[] = [];
    sinon.stub(BlackHoleQueueClient.prototype, 'emit').callsFake(async function (this: BlackHoleQueueClient) {
      connections.push(this.Name);
    });
    defineSchedule(EventsToggleTask, 'ev-routed', { manual: true });
    const { clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' });
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    fail = false;
    await queuedRun('ev-routed', clock.now());
    await s.tickOnce();
    await s.idle();
    await sent();
    expect(connections).to.deep.eq(['scheduler-empty-queue', 'scheduler-empty-queue']);
  });
});
