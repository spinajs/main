import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  FakeClock,
  LeaseStore,
  RunAttemptModel,
  RunContext,
  RunExecutor,
  RunModel,
  ScheduledTask,
  ScheduleModel,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { deferred, driveUntil, getRun, journal, makeDef, queuedRun, seedSchedules, untilAborted } from './support/fixtures.js';

const T = Date.parse('2026-01-05T10:00:00Z');

class Ok extends ScheduledTask {
  public async execute() {
    return { n: 1 };
  }
}
class Boom extends ScheduledTask {
  public async execute() {
    throw new RangeError('out of range');
  }
}
class WaitsForAbort extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await untilAborted(ctx.signal);
  }
}
const stuck = deferred();
class IgnoresAbort extends ScheduledTask {
  public async execute() {
    await stuck.promise;
  }
}

describe('RunExecutor', () => {
  let clock: FakeClock;
  let leases: LeaseStore;
  let executor: RunExecutor;

  async function startRun(name: string, options: object, task: new () => ScheduledTask) {
    const def = makeDef(name, { manual: true, ...options }, task);
    await seedSchedules([def], T);
    const run = await queuedRun(name, T);
    expect(await leases.claimRun(run, T)).to.eq(true);
    return { def, run, handle: executor.start(run, def) };
  }

  beforeEach(async () => {
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    leases = DI.resolve(LeaseStore, ['r1']);
    executor = DI.resolve(RunExecutor, [leases]);
  });

  it('records a successful run', async () => {
    const { run, handle } = await startRun('ok', {}, Ok);
    await handle.done;
    const row = await getRun(run.Id);
    expect(row).to.include({ Status: 'succeeded', Progress: 100, LeaseOwner: null });
    expect(row.Result).to.deep.eq({ n: 1 });
    expect(row.FinishedAt).to.eq(T);
    expect((await journal(run.Id)).map((e) => (e.type === 'status' ? e.status : e.type))).to.deep.eq([
      'running',
      'succeeded',
    ]);
    expect(await RunAttemptModel.where('RunId', run.Id).first()).to.include({ Attempt: 1, Status: 'succeeded' });
    expect(await ScheduleModel.where('Name', 'ok').first()).to.include({
      LeaseOwner: null,
      LastStatus: 'succeeded',
      LastRunId: run.Id,
    });
  });

  it('records a failed run with a structured error', async () => {
    const { run, handle } = await startRun('boom', {}, Boom);
    await handle.done;
    const row = await getRun(run.Id);
    expect(row.Status).to.eq('failed');
    expect(row.Error).to.include({ name: 'RangeError', message: 'out of range', attempt: 1 });
    expect((await journal(run.Id)).map((e) => e.type)).to.deep.eq(['status', 'error', 'status']);
  });

  it('aborts on timeout', async () => {
    const { run, handle } = await startRun('slow', { timeout: '5s' }, WaitsForAbort);
    await driveUntil(clock, handle.done);
    expect(await getRun(run.Id)).to.include({ Status: 'aborted', Reason: 'timeout' });
  });

  it('aborts when a cancel request is seen on the heartbeat', async () => {
    const { run, handle } = await startRun('cancel-me', {}, WaitsForAbort);
    await RunModel.update({ CancelRequested: true }).where('Id', run.Id);
    await driveUntil(clock, handle.done);
    const row = await getRun(run.Id);
    expect(row).to.include({ Status: 'aborted', Reason: 'cancelled' });
    expect(row.Error).to.eq(null);
  });

  it('writes nothing after losing the lease', async () => {
    const { run, handle } = await startRun('lost', {}, WaitsForAbort);
    await RunModel.update({ LeaseOwner: 'r2' }).where('Id', run.Id);
    await driveUntil(clock, handle.done);
    expect(await getRun(run.Id)).to.include({ Status: 'running', LeaseOwner: 'r2' });
  });

  it('finishes when a renewal hangs past the lease TTL', async () => {
    const { run, handle } = await startRun('hang', {}, WaitsForAbort);
    leases.renewRun = () => new Promise(() => undefined);
    await driveUntil(clock, handle.done, 5000);
    expect(await getRun(run.Id)).to.include({ Status: 'running', LeaseOwner: 'r1' });
  });

  it('marks a task that ignores the abort as aborted after the grace period and keeps the schedule lease', async () => {
    const { run, handle } = await startRun('stuck', {}, IgnoresAbort);
    handle.abort('shutdown');
    await driveUntil(clock, handle.done, 500);
    expect(await getRun(run.Id)).to.include({ Status: 'aborted', Reason: 'shutdown' });
    expect((await ScheduleModel.where('Name', 'stuck').first()).LeaseOwner).to.eq('r1');
    stuck.resolve();
  });
});
