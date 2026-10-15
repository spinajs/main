import { expect } from 'chai';
import { InvalidOperation } from '@spinajs/exceptions';
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
  RunStepModel,
  ScheduledTask,
} from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import { deferred, getRun, journal, makeDef, queuedRun, seedSchedules } from './support/fixtures.js';

const T = Date.parse('2026-01-05T10:00:00Z');
let gate = deferred();
let reachedGate = false;
let nestedError: unknown;

class TwoSteps extends ScheduledTask {
  public async execute(ctx: RunContext) {
    ctx.expectSteps(2);
    const items = await ctx.step('load', () => [1, 2, 3]);
    await ctx.step('process', (s) => {
      s.progress({ done: 1, total: 4 });
      s.message('one of four');
    });
    return items.length;
  }
}
class FailsInStep extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('parse', () => {
      throw new SyntaxError('bad csv');
    });
  }
}
class CaughtStepFailure extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('parse', () => Promise.reject(new SyntaxError('bad csv'))).catch(() => undefined);
    await ctx.step('save', () => 1);
    throw new RangeError('after the steps');
  }
}
class Chatty extends ScheduledTask {
  public async execute(ctx: RunContext) {
    ctx.expectSteps(4);
    await ctx.step('a', () => 1);
    await ctx.step('b', async (s) => {
      for (let i = 0; i <= 50; i++) s.progress(i);
      reachedGate = true;
      await gate.promise;
    });
  }
}
class Nested extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('outer', async () => {
      try {
        await ctx.step('inner', () => 1);
      } catch (err) {
        nestedError = err;
      }
    });
  }
}
class Three extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('a', () => 1, { weight: 2 });
    await ctx.step('b', () => 1);
  }
}
let plannedSeen: number | undefined;
class SeesPlan extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('a', () => 1);
    await ctx.step('b', () => {
      plannedSeen = ctx.overallProgress;
    });
  }
}

describe('RunContext steps and progress', () => {
  let clock: FakeClock;
  let leases: LeaseStore;

  async function run(name: string, task: new () => ScheduledTask) {
    const def = makeDef(name, { manual: true }, task);
    await seedSchedules([def], T);
    const row = await queuedRun(name, T);
    await leases.claimRun(row, T);
    return { row, handle: DI.resolve(RunExecutor, [leases]).start(row, def) };
  }

  beforeEach(async () => {
    gate = deferred();
    reachedGate = false;
    nestedError = undefined;
    plannedSeen = undefined;
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    leases = DI.resolve(LeaseStore, ['r1']);
  });

  it('records steps, their results and the events in order', async () => {
    const { row, handle } = await run('two-steps', TwoSteps);
    await handle.done;
    const steps = await RunStepModel.where('RunId', row.Id).orderBy('Seq');
    expect(steps.map((s) => [s.Name, s.Status, s.Seq])).to.deep.eq([
      ['load', 'succeeded', 1],
      ['process', 'succeeded', 2],
    ]);
    expect(steps[0].Result).to.deep.eq([1, 2, 3]);
    expect(steps[1]).to.include({ Done: 1, Total: 4, Message: 'one of four', Progress: 100 });
    const events = (await journal(row.Id)).map((e) =>
      e.type === 'status'
        ? `status:${e.status}`
        : e.type === 'step-start' || e.type === 'step-end'
        ? `${e.type}:${e.step}`
        : e.type,
    );
    expect(events).to.deep.eq([
      'status:running',
      'step-start:load',
      'step-end:load',
      'step-start:process',
      'message',
      'step-end:process',
      'status:succeeded',
    ]);
    expect(await getRun(row.Id)).to.include({ Status: 'succeeded', Progress: 100, Message: 'one of four' });
  });

  it('records the failing step and attributes the run error to it', async () => {
    const { row, handle } = await run('fails', FailsInStep);
    await handle.done;
    const [step] = await RunStepModel.where('RunId', row.Id);
    expect(step.Status).to.eq('failed');
    expect(step.Error).to.include({ name: 'SyntaxError', step: 'parse' });
    expect((await getRun(row.Id)).Error).to.include({ step: 'parse' });
  });

  it('does not attribute an error thrown after the steps to an earlier failed step', async () => {
    const { row, handle } = await run('caught', CaughtStepFailure);
    await handle.done;
    const error = (await getRun(row.Id)).Error;
    expect(error).to.include({ name: 'RangeError' });
    expect(error).to.not.have.property('step');
  });

  it('rolls progress up and writes it once per flush', async () => {
    const { row, handle } = await run('chatty', Chatty);
    await waitFor(() => reachedGate);
    await clock.advance(1000);
    await waitFor(async () => (await getRun(row.Id)).Progress === 37);
    expect((await getRun(row.Id)).CurrentStep).to.eq('b');
    // the progress event is journaled right after the run row is renewed
    await waitFor(async () => (await journal(row.Id)).some((e) => e.type === 'progress'));
    const progressEvents = (await journal(row.Id)).filter((e) => e.type === 'progress');
    expect(progressEvents).to.have.length(1);
    expect(progressEvents[0]).to.include({ progress: 37, step: 'b', stepProgress: 50 });
    await waitFor(async () => (await RunStepModel.where('RunId', row.Id).where('Name', 'b').first()).Progress === 50);

    // nothing changed since: the next beat writes no progress event
    await clock.advance(1000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await journal(row.Id)).filter((e) => e.type === 'progress')).to.have.length(1);
    gate.resolve();
    await handle.done;
  });

  it('refuses nested steps', async () => {
    const { handle } = await run('nested', Nested);
    await handle.done;
    expect(nestedError).to.be.instanceOf(InvalidOperation);
  });

  it('plans the run with the step weights of the last succeeded run', async () => {
    await (
      await run('planned', Three)
    ).handle.done;
    const def = makeDef('planned', { manual: true }, SeesPlan);
    const row = await queuedRun('planned', T + 1000);
    await leases.claimRun(row, T + 1000);
    await DI.resolve(RunExecutor, [leases]).start(row, def).done;
    // 'a' (weight 1) done out of the previous run's weight 3; without the plan it would be 1 of 2 seen
    expect(plannedSeen).to.eq(33);
    expect((await getRun(row.Id)).Status).to.eq('succeeded');
  });
});

describe('RunContext flush bookkeeping', () => {
  let ctx: RunContext;
  let ac: AbortController;
  let runId: string;

  beforeEach(async () => {
    await bootTestEnv({ now: '2026-01-05T10:00:00Z' });
    const row = await queuedRun('manual', T, { Status: 'running', StartedAt: T });
    runId = row.Id;
    ac = new AbortController();
    ctx = new RunContext({
      run: row,
      def: {} as never,
      signal: ac.signal,
      events: DI.resolve(RunEventWriter),
      clock: DI.resolve(DbClock),
      log: DI.resolve(Log, ['SCHEDULER']),
      config: resolveSchedulerConfig({}),
    });
  });

  it('stays dirty when progress changes while a flush is in flight', () => {
    ctx.progress(10);
    expect(ctx.snapshot()).to.include({ Progress: 10 });
    ctx.progress(20);
    ctx.markFlushed();
    expect(ctx.dirty).to.eq(true);
    expect(ctx.snapshot()).to.include({ Progress: 20 });
    ctx.markFlushed();
    expect(ctx.dirty).to.eq(false);
  });

  it('ends a step left open at close as aborted and journals nothing afterwards', async () => {
    const left = deferred();
    void ctx.step('stuck', () => left.promise).catch(() => undefined);
    await waitFor(() => ctx.currentStepName === 'stuck');
    ac.abort('timeout');
    await ctx.close({ kind: 'aborted', reason: 'timeout', settled: false });
    expect(ctx.stepOf({ kind: 'aborted', reason: 'timeout', settled: false })).to.eq('stuck');
    ctx.message('too late');
    left.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const [step] = await RunStepModel.where('RunId', runId);
    expect(step.Status).to.eq('aborted');
    const events = (await journal(runId)).map((e) => (e.type === 'step-end' ? `step-end:${e.status}` : e.type));
    expect(events).to.deep.eq(['step-start', 'step-end:aborted']);
  });
});
