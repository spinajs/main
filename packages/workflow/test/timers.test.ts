import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { FaultInjector } from '@spinajs/durable';
import { v5 as uuidv5 } from 'uuid';
import { unitHash, Workflow, WORKFLOW_NAMESPACE, WorkflowDefinition, WorkflowService, type WorkflowContext } from '../src/index.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import type { FakeClock } from '@spinajs/durable/testing';
import { TestCrash, TestFaults } from './support/faults.js';
import { instance, pick, rejects, stepsOf, T0 } from './support/rows.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

@Workflow('tm-nap')
export class TmNap extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    await ctx.sleep('3d', 'nap');
    return 'rested';
  }
}

@Workflow('tm-until')
export class TmUntil extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    await ctx.sleepUntil(new Date(T0 - 1000), 'past');
    return 'done';
  }
}

@Workflow('tm-now')
export class TmNow extends WorkflowDefinition<null, { first: number; after: number }> {
  public async run(ctx: WorkflowContext<null>): Promise<{ first: number; after: number }> {
    const first = ctx.now();
    await ctx.sleep('1h');
    return { first, after: ctx.now() };
  }
}

@Workflow('tm-ids')
export class TmIds extends WorkflowDefinition<null, { id: string; r: number; again: string }> {
  public async run(ctx: WorkflowContext<null>): Promise<{ id: string; r: number; again: string }> {
    const id = ctx.uuid();
    const r = ctx.random();
    await ctx.sleep('1m');
    return { id, r, again: ctx.uuid() };
  }
}

/** A step after a sleep: the replay hands the woken sleep back through the gate before the step's recorded result. */
@Workflow('tm-then')
export class TmThen extends WorkflowDefinition<null, string[]> {
  public async run(ctx: WorkflowContext<null>): Promise<string[]> {
    const a = await ctx.step('a', () => 'A');
    await ctx.sleep('1h');
    const b = await ctx.step('b', () => 'B');
    await ctx.sleep('1h', 'again');
    return [a, b];
  }
}

describe('durable timers and markers', () => {
  let service: WorkflowService;
  let clock: FakeClock;

  beforeEach(async () => {
    TestFaults.reset();
    ({ clock } = await bootTestEnv({ register: () => DI.register(TestFaults).as(FaultInjector) }));
    service = await DI.resolve(WorkflowService);
  });
  after(disposeTestEnv);

  it('sleeps three days on the database clock and wakes once', async () => {
    const { id } = await service.start('tm-nap', null);
    const r1 = await engine();
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WakeAt', 'ClaimedBy')).to.deep.equal({ Status: 'sleeping', WakeAt: T0 + 3 * DAY, ClaimedBy: null });
    const [row] = await stepsOf(id);
    expect(pick(row, 'Key', 'Kind', 'Status', 'Meta')).to.deep.equal({ Key: 'sleep:nap#1', Kind: 'sleep', Status: 'pending', Meta: { wakeAt: T0 + 3 * DAY, after: 0 } });
    clock.set(T0 + 3 * DAY - 1);
    await r1.tick();
    expect((await instance(id)).Status).to.equal('sleeping');
    clock.set(T0 + 3 * DAY);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'rested' });
    expect(pick((await stepsOf(id))[0], 'Status', 'StartedAt', 'FinishedAt')).to.deep.equal({ Status: 'succeeded', StartedAt: T0, FinishedAt: T0 + 3 * DAY });
  });

  it('a crash between the sleep marker and the park keeps the recorded wake time', async () => {
    TestFaults.crashOnce('workflow.after-journal', 'sleep:nap');
    const { id } = await service.start('tm-nap', null);
    expect(await rejects((await engine('r1')).tick())).to.be.instanceOf(TestCrash);
    expect(pick(await instance(id), 'Status', 'ClaimedBy')).to.deep.equal({ Status: 'running', ClaimedBy: 'r1' });
    expect((await stepsOf(id))[0].Meta).to.deep.equal({ wakeAt: T0 + 3 * DAY, after: 0 });
    clock.set(T0 + 60_001);
    await (await engine('r2')).tick();
    expect(pick(await instance(id), 'Status', 'WakeAt')).to.deep.equal({ Status: 'sleeping', WakeAt: T0 + 3 * DAY });
  });

  it('a marker whose journal write fails aborts the activation instead of replaying another value', async () => {
    TestFaults.failure = (p, detail) => (p === 'workflow.before-journal' && String(detail?.key).startsWith('marker:now') ? new Error('disk full') : undefined);
    const { id } = await service.start('tm-now', null);
    const r1 = await engine();
    await r1.tick();
    // nothing of the activation committed, not even the sleep queued behind the marker; the row was released for a replay
    expect(pick(await instance(id), 'Status', 'ClaimedBy')).to.deep.equal({ Status: 'running', ClaimedBy: null });
    expect(await stepsOf(id)).to.have.length(0);
    TestFaults.reset();
    clock.set(T0 + HOUR);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WakeAt')).to.deep.equal({ Status: 'sleeping', WakeAt: T0 + 2 * HOUR });
    expect((await stepsOf(id)).map((s) => [s.Key, s.Result ?? null])).to.deep.equal([
      ['marker:now#1', T0 + HOUR],
      ['sleep:sleep#1', null],
    ]);
  });

  it('a sleep whose journal write fails abandons the activation instead of failing the run', async () => {
    TestFaults.failure = (p, detail) => (p === 'workflow.before-journal' && String(detail?.key).startsWith('sleep:nap') ? new Error('disk full') : undefined);
    const { id } = await service.start('tm-nap', null);
    await (await engine()).tick();
    expect(pick(await instance(id), 'Status', 'Error', 'ClaimedBy')).to.deep.equal({ Status: 'running', Error: null, ClaimedBy: null });
    expect(await stepsOf(id)).to.have.length(0);
  });

  it('sleepUntil an instant that has passed completes at once and is journaled', async () => {
    const { id } = await service.start('tm-until', null);
    await (await engine()).tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'done' });
    expect(pick((await stepsOf(id))[0], 'Key', 'Status', 'Meta')).to.deep.equal({ Key: 'sleep:past#1', Status: 'succeeded', Meta: { wakeAt: T0 - 1000, after: 0, order: 1 } });
  });

  it('now() replays the value of its first run', async () => {
    const { id } = await service.start('tm-now', null);
    const r1 = await engine();
    await r1.tick();
    clock.set(T0 + HOUR);
    await r1.tick();
    expect((await instance(id)).Result).to.deep.equal({ first: T0, after: T0 + HOUR });
    expect((await stepsOf(id)).map((s) => [s.Key, s.Result ?? null])).to.deep.equal([
      ['marker:now#1', T0],
      ['sleep:sleep#1', null],
      ['marker:now#2', T0 + HOUR],
    ]);
  });

  it('uuid() and random() derive from the instance and the key, and are journaled as markers', async () => {
    await service.start('tm-ids', null, { id: 'ids-1' });
    const r1 = await engine();
    await r1.tick();
    clock.set(T0 + 60_000);
    await r1.tick();
    const result = (await instance('ids-1')).Result as { id: string; r: number; again: string };
    expect(result).to.deep.equal({
      id: uuidv5('ids-1:marker:uuid#1', WORKFLOW_NAMESPACE),
      r: unitHash('ids-1:marker:random#1'),
      again: uuidv5('ids-1:marker:uuid#2', WORKFLOW_NAMESPACE),
    });
    expect(result.r).to.be.within(0, 1);
    const markers = (await stepsOf('ids-1')).filter((s) => s.Kind === 'marker').map((s) => [s.Key, s.Result]);
    expect(markers).to.deep.equal([
      ['marker:uuid#1', result.id],
      ['marker:random#1', result.r],
      ['marker:uuid#2', result.again],
    ]);
  });

  it('a woken sleep is a delivered result: the replay after it is gated and completes', async () => {
    const { id } = await service.start('tm-then', null);
    const r1 = await engine();
    await r1.tick();
    clock.set(T0 + HOUR);
    await r1.tick();
    clock.set(T0 + 2 * HOUR);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: ['A', 'B'] });
    expect((await stepsOf(id)).map((s) => [s.Key, s.Meta?.after, s.Meta?.order])).to.deep.equal([
      ['step:a#1', 0, 1],
      ['sleep:sleep#1', 1, 2],
      ['step:b#1', 2, 3],
      ['sleep:again#1', 3, 4],
    ]);
  });
});
