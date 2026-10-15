import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  buildResumeMap,
  defineSchedule,
  FakeClock,
  RunContext,
  RunStepModel,
  Scheduler,
  ScheduledTask,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { getRun, journal, queuedRun } from './support/fixtures.js';

describe('buildResumeMap', () => {
  const r = (
    Attempt: number,
    Seq: number,
    Name: string,
    Status: 'succeeded' | 'failed' | 'skipped',
    Result: unknown = null,
  ) => ({
    Attempt,
    Seq,
    Name,
    Status,
    Result,
  });

  it('keeps succeeded and skipped steps by name and occurrence', () => {
    const map = buildResumeMap([
      r(1, 1, 'load', 'succeeded', [1]),
      r(1, 2, 'page', 'succeeded', 'p1'),
      r(1, 3, 'page', 'succeeded', 'p2'),
      r(1, 4, 'save', 'failed'),
    ]);
    expect([...map.entries()]).to.deep.eq([
      ['load#1', [1]],
      ['page#1', 'p1'],
      ['page#2', 'p2'],
    ]);
  });

  it('drops everything from fromStep on', () => {
    const map = buildResumeMap(
      [r(1, 1, 'load', 'succeeded', 1), r(1, 2, 'transform', 'succeeded', 2), r(1, 3, 'save', 'failed')],
      'transform',
    );
    expect([...map.keys()]).to.deep.eq(['load#1']);
  });

  it('carries skipped results across attempts', () => {
    const map = buildResumeMap([
      r(1, 1, 'load', 'succeeded', 1),
      r(1, 2, 'save', 'failed'),
      r(2, 1, 'load', 'skipped', 1),
      r(2, 2, 'save', 'failed'),
    ]);
    expect([...map.entries()]).to.deep.eq([['load#1', 1]]);
  });
});

let loads = 0;
let saveCalls = 0;
let received: unknown;
let checkpointSeen: unknown;
class ResumableImport extends ScheduledTask {
  public async execute(ctx: RunContext) {
    checkpointSeen = ctx.lastCheckpoint;
    const rows = await ctx.step('load', async () => {
      loads++;
      await ctx.checkpoint({ loaded: 3 });
      return { rows: 3 };
    });
    await ctx.step('save', () => {
      received = rows;
      if (++saveCalls === 1) throw new Error('db down');
    });
  }
}

const NAMES = ['resumable-import', 'plain-import', 'resumed-retry'];

describe('resume on automatic retry', () => {
  let clock: FakeClock;
  let s: Scheduler;
  const tick = async () => {
    await s.tickOnce();
    await s.idle();
  };

  beforeEach(() => {
    loads = 0;
    saveCalls = 0;
    received = undefined;
    checkpointSeen = undefined;
  });
  afterEach(() => NAMES.forEach(undefineSchedule));

  async function boot() {
    defineSchedule(ResumableImport, 'resumable-import', {
      manual: true,
      resumable: true,
      retry: { attempts: 2, delay: '1s' },
    });
    defineSchedule(ResumableImport, 'plain-import', { manual: true, retry: { attempts: 2, delay: '1s' } });
    defineSchedule(ResumableImport, 'resumed-retry', { manual: true, retry: { attempts: 3, delay: '1s' } });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
  }

  it('skips completed steps, returns their stored results and hands over the checkpoint', async () => {
    await boot();
    const run = await queuedRun('resumable-import', clock.now(), { MaxAttempts: 2 });
    await tick();
    clock.set(clock.now() + 1000);
    await tick();
    expect((await getRun(run.Id)).Status).to.eq('succeeded');
    expect(loads).to.eq(1);
    expect(received).to.deep.eq({ rows: 3 });
    expect(checkpointSeen).to.deep.eq({ loaded: 3 });
    const second = await RunStepModel.where('RunId', run.Id).where('Attempt', 2).orderBy('Seq');
    expect(second.map((x) => [x.Name, x.Status])).to.deep.eq([
      ['load', 'skipped'],
      ['save', 'succeeded'],
    ]);
    expect(second[0].Result).to.deep.eq({ rows: 3 });
    const steps = (await journal(run.Id)).flatMap((e) => {
      if (e.attempt !== 2) return [];
      if (e.type === 'step-start') return [`start:${e.step}`];
      return e.type === 'step-end' ? [`end:${e.step}:${e.status}`] : [];
    });
    expect(steps).to.deep.eq(['start:load', 'end:load:skipped', 'start:save', 'end:save:succeeded']);
  });

  it('re-runs every step when the schedule is not resumable', async () => {
    await boot();
    await queuedRun('plain-import', clock.now(), { MaxAttempts: 2 });
    await tick();
    clock.set(clock.now() + 1000);
    await tick();
    expect(loads).to.eq(2);
  });

  it('a resumed manual retry also skips the steps its own earlier attempt completed', async () => {
    await boot();
    // the failed parent: nothing of it is reused because the retry restarts at `load`
    const parent = await queuedRun('resumed-retry', clock.now(), {
      Status: 'failed',
      StartedAt: clock.now(),
      MaxAttempts: 3,
    });
    await RunStepModel.create({
      RunId: parent.Id,
      Attempt: 1,
      Seq: 1,
      Name: 'load',
      Status: 'succeeded',
      Weight: 1,
      StartedAt: clock.now(),
      Progress: 100,
      Result: { rows: 99 },
    });
    const retry = await queuedRun('resumed-retry', clock.now(), {
      Trigger: 'retry',
      ParentRunId: parent.Id,
      Attempt: 2,
      MaxAttempts: 3,
      ResumeFrom: { runId: parent.Id, fromStep: 'load' },
    });
    await tick();
    expect(await getRun(retry.Id)).to.include({ Status: 'retrying', Attempt: 2 });
    clock.set(clock.now() + 1000);
    await tick();
    expect(await getRun(retry.Id)).to.include({ Status: 'succeeded', Attempt: 3 });
    expect(loads).to.eq(1);
    expect(received).to.deep.eq({ rows: 3 });
  });
});
