import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  defineSchedule,
  FakeClock,
  isTerminalEvent,
  NonRetryableError,
  RunAttemptModel,
  RunContext,
  RunEventHub,
  Scheduler,
  ScheduledTask,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { driveUntil, getRun, journal, queuedRun, untilAborted } from './support/fixtures.js';

let calls = 0;
class FlakyTwice extends ScheduledTask {
  public async execute() {
    if (++calls <= 2) throw new Error(`flaky ${calls}`);
    return 'ok';
  }
}
class AlwaysFails extends ScheduledTask {
  public async execute() {
    throw new Error('always');
  }
}
class FatalConfig extends ScheduledTask {
  public async execute() {
    throw new NonRetryableError('bad config');
  }
}
class RetryPatient extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await untilAborted(ctx.signal);
  }
}

const DEFS: Array<[string, new () => ScheduledTask, object]> = [
  ['flaky', FlakyTwice, { manual: true, retry: { attempts: 3, delay: '1m' } }],
  ['always', AlwaysFails, { manual: true, retry: { attempts: 2, delay: '1m' } }],
  ['fatal', FatalConfig, { manual: true, retry: { attempts: 3, delay: '1m' } }],
  ['expo', AlwaysFails, { manual: true, retry: { attempts: 3, backoff: 'exponential', delay: '1m', maxDelay: '30m' } }],
  ['patient', RetryPatient, { manual: true, retry: { attempts: 3, delay: '1m' } }],
  ['slow', RetryPatient, { manual: true, timeout: '5s', retry: { attempts: 2, delay: '1m' } }],
  ['no-retry', AlwaysFails, { manual: true }],
];

const statuses = async (runId: string) =>
  (await journal(runId)).flatMap((e) => (e.type === 'status' ? [e.status] : []));

describe('automatic retries', () => {
  let clock: FakeClock;
  let s: Scheduler;
  const tick = async () => {
    await s.tickOnce();
    await s.idle();
  };

  beforeEach(async () => {
    calls = 0;
    DEFS.forEach(([name, task, options]) => defineSchedule(task, name, options));
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
  });
  afterEach(() => DEFS.forEach(([name]) => undefineSchedule(name)));

  it('retries the same run until it succeeds', async () => {
    const run = await queuedRun('flaky', clock.now(), { MaxAttempts: 3 });
    await tick();
    expect(await getRun(run.Id)).to.include({ Status: 'retrying', Attempt: 1, NextAttemptAt: clock.now() + 60_000 });
    await tick();
    expect((await getRun(run.Id)).Attempt).to.eq(1);
    clock.set(clock.now() + 60_000);
    await tick();
    clock.set(clock.now() + 60_000);
    await tick();
    expect(await getRun(run.Id)).to.include({ Status: 'succeeded', Attempt: 3, Error: null, NextAttemptAt: null });
    const attempts = await RunAttemptModel.where('RunId', run.Id).orderBy('Attempt');
    expect(attempts.map((a) => [a.Attempt, a.Status])).to.deep.eq([
      [1, 'failed'],
      [2, 'failed'],
      [3, 'succeeded'],
    ]);
    expect(attempts[0].Error).to.include({ message: 'flaky 1', attempt: 1 });
    expect(await statuses(run.Id)).to.deep.eq(['running', 'retrying', 'running', 'retrying', 'running', 'succeeded']);
  });

  it('marks the run dead when attempts run out', async () => {
    const run = await queuedRun('always', clock.now(), { MaxAttempts: 2 });
    await tick();
    clock.set(clock.now() + 60_000);
    await tick();
    expect(await getRun(run.Id)).to.include({ Status: 'dead', Attempt: 2, NextAttemptAt: null });
    expect((await getRun(run.Id)).FinishedAt).to.eq(clock.now());
    expect(await statuses(run.Id)).to.deep.eq(['running', 'retrying', 'running', 'dead']);
  });

  it("takes the attempt budget from the run's MaxAttempts, not from the current definition", async () => {
    // e.g. a manual retry given its own budget, or a definition changed while the run was in flight
    const run = await queuedRun('always', clock.now(), { MaxAttempts: 3 });
    await tick();
    clock.set(clock.now() + 60_000);
    await tick();
    expect(await getRun(run.Id)).to.include({ Status: 'retrying', Attempt: 2 });
    clock.set(clock.now() + 60_000);
    await tick();
    expect(await getRun(run.Id)).to.include({ Status: 'dead', Attempt: 3 });
  });

  it('keeps a run subscription open through retrying until the final status', async () => {
    const run = await queuedRun('always', clock.now(), { MaxAttempts: 2 });
    const seen: string[] = [];
    let ended = false;
    const off = await DI.resolve(RunEventHub).subscribe({ runId: run.Id }, (e) => {
      if (ended) return;
      if (e.type === 'status') seen.push(e.status);
      ended = isTerminalEvent(e);
    });
    await tick();
    expect(ended).to.eq(false);
    clock.set(clock.now() + 60_000);
    await tick();
    off();
    expect(ended).to.eq(true);
    expect(seen).to.deep.eq(['running', 'retrying', 'running', 'dead']);
  });

  it('does not retry a NonRetryableError', async () => {
    const run = await queuedRun('fatal', clock.now(), { MaxAttempts: 3 });
    await tick();
    expect(await getRun(run.Id)).to.include({ Status: 'failed', Attempt: 1 });
  });

  it('does not retry without a policy', async () => {
    const run = await queuedRun('no-retry', clock.now());
    await tick();
    expect(await getRun(run.Id)).to.include({ Status: 'failed', Attempt: 1, NextAttemptAt: null });
  });

  it('backs off exponentially with jitter', async () => {
    const run = await queuedRun('expo', clock.now(), { MaxAttempts: 3 });
    await tick();
    const delay = (await getRun(run.Id)).NextAttemptAt! - clock.now();
    expect(delay).to.be.within(54_000, 66_000);
  });

  it('retries a timed-out attempt', async () => {
    const run = await queuedRun('slow', clock.now(), { MaxAttempts: 2 });
    await s.tickOnce();
    await driveUntil(clock, s.idle());
    expect(await getRun(run.Id)).to.include({ Status: 'retrying', Reason: 'timeout', Attempt: 1 });
    expect((await RunAttemptModel.where('RunId', run.Id).first()).Status).to.eq('failed');
  });

  it('turns a shutdown into a retry', async () => {
    const run = await queuedRun('patient', clock.now(), { MaxAttempts: 3 });
    await s.tickOnce();
    await s.stop();
    const row = await getRun(run.Id);
    expect(row).to.include({ Status: 'retrying', Reason: 'shutdown', LeaseOwner: null, FinishedAt: null });
    expect(row.NextAttemptAt).to.eq(clock.now() + 60_000);
    expect(await statuses(run.Id)).to.deep.eq(['running', 'retrying']);
  });

  it('turns an expired lease into a retry that another replica runs', async () => {
    const ghost = await queuedRun('flaky', clock.now(), {
      Status: 'running',
      LeaseOwner: 'dead-replica',
      LeaseUntil: clock.now() - 1,
      StartedAt: clock.now() - 120_000,
      MaxAttempts: 3,
    });
    calls = 2;
    await tick();
    expect(await getRun(ghost.Id)).to.include({ Status: 'retrying', Reason: 'lease-expired' });
    clock.set(clock.now() + 60_000);
    await tick();
    expect(await getRun(ghost.Id)).to.include({ Status: 'succeeded', Attempt: 2 });
    expect(await statuses(ghost.Id)).to.deep.eq(['retrying', 'running', 'succeeded']);
  });

  it('marks an expired run dead when it was the last attempt', async () => {
    const ghost = await queuedRun('flaky', clock.now(), {
      Status: 'running',
      Attempt: 3,
      LeaseOwner: 'dead-replica',
      LeaseUntil: clock.now() - 1,
      StartedAt: clock.now() - 120_000,
      MaxAttempts: 3,
    });
    await tick();
    expect(await getRun(ghost.Id)).to.include({ Status: 'dead', Reason: 'lease-expired', Attempt: 3 });
  });
});
