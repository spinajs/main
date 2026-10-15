import { expect } from 'chai';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import {
  DbClock,
  FakeClock,
  LeaseStore,
  resolveSchedulerConfig,
  RunContext,
  RunEventWriter,
  RunExecutor,
  RunModel,
  RunStepModel,
  ScheduledTask,
} from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import {
  deferred,
  driveUntil,
  getRun,
  journal,
  makeDef,
  queuedRun,
  seedSchedules,
  untilAborted,
} from './support/fixtures.js';

const T = Date.parse('2026-01-05T10:00:00Z');
let gate = deferred();
let reachedGate = false;
let plannedSeen: number | undefined;

class KeepsWorkingAfterLoss extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('work', async (s) => {
      reachedGate = true;
      await untilAborted(ctx.signal).catch(() => undefined);
      s.message('after the loss');
      ctx.log.info('after the loss');
      throw new Error('stopped');
    });
  }
}
class StepsOnly extends ScheduledTask {
  public async execute(ctx: RunContext) {
    ctx.expectSteps(2);
    await ctx.step('a', () => 1);
    await ctx.step('b', async () => {
      reachedGate = true;
      await gate.promise;
    });
  }
}
class PlainTwoSteps extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('a', () => 1);
    await ctx.step('b', () => 1);
  }
}
class WeighsFive extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('a', () => 1, { weight: 4 });
    await ctx.step('b', () => 1);
  }
}
class WeighsThree extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('a', () => 1, { weight: 2 });
    await ctx.step('b', () => 1);
  }
}
class SeesLatestPlan extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('a', () => 1);
    await ctx.step('b', () => {
      plannedSeen = ctx.overallProgress;
    });
  }
}
class PlanLookupFails extends RunExecutor {
  protected lastSucceededWeight(): Promise<number> {
    return Promise.reject(new Error('database gone'));
  }
}

describe('RunContext guards (executor)', () => {
  let clock: FakeClock;
  let leases: LeaseStore;

  async function start(name: string, task: new () => ScheduledTask, at = T, executor = RunExecutor) {
    const def = makeDef(name, { manual: true }, task);
    await seedSchedules([def], at);
    const row = await queuedRun(name, at);
    await leases.claimRun(row, at);
    return { row, handle: DI.resolve(executor, [leases]).start(row, def) };
  }

  beforeEach(async () => {
    gate = deferred();
    reachedGate = false;
    plannedSeen = undefined;
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    leases = DI.resolve(LeaseStore, ['r1']);
  });

  it('journals nothing once another replica took the run over', async () => {
    const { row, handle } = await start('taken-over', KeepsWorkingAfterLoss);
    await waitFor(() => reachedGate);
    // what a reaper on another replica does, minus its own journal rows
    await RunModel.update({ LeaseOwner: 'r2' }).where('Id', row.Id);
    const before = (await journal(row.Id)).map((e) => e.type);

    await driveUntil(clock, handle.done);
    expect((await journal(row.Id)).map((e) => e.type)).to.deep.eq(before);
    // the step row belongs to this attempt only, so it is still closed
    expect((await RunStepModel.where('RunId', row.Id).first()).Status).to.eq('aborted');
  });

  it('emits a progress event for a completed step without any progress() call', async () => {
    const { row, handle } = await start('steps-only', StepsOnly);
    await waitFor(() => reachedGate);
    await clock.advance(1000);
    await waitFor(async () => (await journal(row.Id)).some((e) => e.type === 'progress'));
    const progress = (await journal(row.Id)).filter((e) => e.type === 'progress');
    expect(progress).to.have.length(1);
    expect(progress[0]).to.include({ progress: 50, step: 'b', stepProgress: 0 });
    gate.resolve();
    await handle.done;
  });

  it('plans with the most recently finished of several succeeded runs', async () => {
    await (
      await start('planned', WeighsFive)
    ).handle.done;
    await clock.advance(60_000);
    await (
      await start('planned', WeighsThree, T + 60_000)
    ).handle.done;
    await clock.advance(60_000);
    await (
      await start('planned', SeesLatestPlan, T + 120_000)
    ).handle.done;
    // 1 of the latest run's weight 3; the older run's weight 5 would give 20
    expect(plannedSeen).to.eq(33);
  });

  it('runs without a plan when the planned-weight lookup fails', async () => {
    const { row, handle } = await start('no-plan', PlainTwoSteps, T, PlanLookupFails);
    await handle.done;
    expect((await getRun(row.Id)).Status).to.eq('succeeded');
  });
});

describe('RunContext guards (hand-built context)', () => {
  let ctx: RunContext;
  let runId: string;

  beforeEach(async () => {
    await bootTestEnv({ now: '2026-01-05T10:00:00Z' });
    const row = await queuedRun('manual', T, { Status: 'running', StartedAt: T });
    runId = row.Id;
    ctx = new RunContext({
      run: row,
      def: {} as never,
      signal: new AbortController().signal,
      events: DI.resolve(RunEventWriter),
      clock: DI.resolve(DbClock),
      log: DI.resolve(Log, ['SCHEDULER']),
      config: resolveSchedulerConfig({}),
      saveCheckpoint: () => Promise.resolve(true),
    });
  });

  it('rejects weights that are not finite or negative', async () => {
    expect(() => ctx.expectSteps(NaN)).to.throw(InvalidArgument);
    expect(() => ctx.expectSteps(-1)).to.throw(InvalidArgument);
    let err: unknown;
    await ctx.step('a', () => 1, { weight: Infinity }).catch((e: unknown) => (err = e));
    expect(err).to.be.instanceOf(InvalidArgument);
    expect(await RunStepModel.where('RunId', runId)).to.have.length(0);
    ctx.expectSteps(0);
    expect(ctx.overallProgress).to.eq(0);
  });

  it('rejects step input the step row cannot store', async () => {
    const failure = (work: Promise<unknown>) =>
      work.then(
        () => null,
        (e: unknown) => e,
      );
    expect(await failure(ctx.step('x'.repeat(129), () => 1))).to.be.instanceOf(InvalidArgument);
    expect(await failure(ctx.step('a', () => 1, { weight: 1e12 }))).to.be.instanceOf(InvalidArgument);
    expect(() => ctx.expectSteps(1e12)).to.throw(InvalidArgument);
    expect(await RunStepModel.where('RunId', runId)).to.have.length(0);

    await ctx.step('y'.repeat(128), (s) => {
      expect(() => s.progress({ done: NaN, total: 10 })).to.throw(InvalidArgument);
      expect(() => s.progress({ done: 1, total: Infinity })).to.throw(InvalidArgument);
      expect(() => s.progress({ done: 1, total: 2 ** 60 })).to.throw(InvalidArgument);
      s.progress({ done: 2.5, total: 3_000_000_000 });
    });
    expect(await RunStepModel.where('RunId', runId)).to.have.length(1);
  });

  it('clears done and total on the step row when progress switches to a plain number', async () => {
    const hold = deferred();
    const step = ctx.step('a', async (s) => {
      s.progress({ done: 1, total: 4 });
      ctx.snapshot();
      ctx.markFlushed();
      await waitFor(async () => (await RunStepModel.where('RunId', runId).first()).Done === 1);
      s.progress(50);
      ctx.snapshot();
      ctx.markFlushed();
      await hold.promise;
    });
    const row = async () => RunStepModel.where('RunId', runId).first();
    await waitFor(async () => (await row()).Progress === 50);
    expect(await row()).to.include({ Done: null, Total: null });
    hold.resolve();
    await step;
  });

  it('does not leave a running step row when the run ends while the step is being created', async () => {
    const late = ctx.step('late', () => 1);
    let concurrent: unknown;
    await ctx.step('other', () => 1).catch((e: unknown) => (concurrent = e));
    await ctx.close({ kind: 'ok', value: undefined });

    let err: unknown;
    await late.catch((e: unknown) => (err = e));
    expect(concurrent).to.be.instanceOf(InvalidOperation);
    expect(err).to.be.instanceOf(InvalidOperation);
    const steps = await RunStepModel.where('RunId', runId);
    expect(steps.map((s) => [s.Name, s.Status])).to.deep.eq([['late', 'aborted']]);
    expect(await journal(runId)).to.have.length(0);
  });
});
