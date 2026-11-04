import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { mergePark, Workflow, WorkflowDefinition, WorkflowService, type WorkflowContext, type WorkflowEngine } from '../src/index.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import type { FakeClock } from '@spinajs/durable/testing';
import { instance, pick, seedEvent, stepsOf, T0 } from './support/rows.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Workflow('pk-two-waits')
export class PkTwoWaits extends WorkflowDefinition<null, unknown> {
  public async run(ctx: WorkflowContext<null>): Promise<unknown> {
    const e = await Promise.race([ctx.waitForEvent<string>('approve'), ctx.waitForEvent<string>('reject')]);
    return e?.name;
  }
}

@Workflow('pk-wait-or-sleep')
export class PkWaitOrSleep extends WorkflowDefinition<null, unknown> {
  public async run(ctx: WorkflowContext<null>): Promise<unknown> {
    const e = await Promise.race([ctx.waitForEvent<string>('approve'), ctx.sleep('1d').then(() => 'timeout')]);
    return typeof e === 'string' ? e : e?.name;
  }
}

@Workflow('pk-sleep-or-work')
export class PkSleepOrWork extends WorkflowDefinition<null, unknown> {
  public async run(ctx: WorkflowContext<null>): Promise<unknown> {
    const work = (async () => {
      await ctx.step('w1', () => 1);
      await ctx.step('w2', () => 2);
      return 'work';
    })();
    return Promise.race([ctx.sleep('1d').then(() => 'timeout'), work]);
  }
}

@Workflow('pk-fan-sleep')
export class PkFanSleep extends WorkflowDefinition<null, unknown> {
  public async run(ctx: WorkflowContext<null>): Promise<unknown> {
    return Promise.all(
      [0, 1, 2].map(async (i) => {
        const a = await ctx.step('a', async () => {
          await pause(5 * (3 - i));
          return i;
        });
        await ctx.sleep('1h');
        return ctx.step('b', () => a * 10);
      }),
    );
  }
}

describe('lazy park', () => {
  let service: WorkflowService;
  let clock: FakeClock;
  let r1: WorkflowEngine;

  beforeEach(async () => {
    ({ clock } = await bootTestEnv());
    service = await DI.resolve(WorkflowService);
    r1 = await engine();
  });
  after(disposeTestEnv);

  it('merges parks: waiting wins, the earliest wake time, one name or *', () => {
    const sleeping = { status: 'sleeping' as const, wakeAt: T0 + HOUR, waitingFor: null };
    const waitA = { status: 'waiting' as const, wakeAt: null, waitingFor: 'a' };
    expect(mergePark(sleeping, waitA)).to.deep.equal({ status: 'waiting', wakeAt: T0 + HOUR, waitingFor: 'a' });
    expect(mergePark(waitA, { ...waitA, wakeAt: T0 })).to.deep.equal({ status: 'waiting', wakeAt: T0, waitingFor: 'a' });
    expect(mergePark(waitA, { ...waitA, waitingFor: 'b' })).to.deep.equal({ status: 'waiting', wakeAt: null, waitingFor: '*' });
    expect(mergePark(sleeping, { ...sleeping, wakeAt: T0 })).to.deep.equal({ status: 'sleeping', wakeAt: T0, waitingFor: null });
  });

  it('a race of two waits parks on * and the second name wakes and wins it', async () => {
    const { id } = await service.start('pk-two-waits', null);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WaitingFor', 'WakeAt')).to.deep.equal({ Status: 'waiting', WaitingFor: '*', WakeAt: null });
    await service.signal(id, 'reject', 'x');
    expect(pick(await instance(id), 'Status', 'WaitingFor')).to.deep.equal({ Status: 'running', WaitingFor: null });
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'reject' });
    // the losing wait stays pending
    expect((await stepsOf(id)).map((s) => [s.Key, s.Status])).to.deep.equal([
      ['wait:approve#1', 'pending'],
      ['wait:reject#1', 'succeeded'],
    ]);
  });

  it('a race of two waits: the first name wins it as well', async () => {
    const { id } = await service.start('pk-two-waits', null);
    await r1.tick();
    await service.signal(id, 'approve', 'x');
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'approve' });
  });

  it('* wakes only for a name with a pending wait: an unrelated event neither flips nor loops the instance', async () => {
    const { id } = await service.start('pk-two-waits', null);
    await r1.tick();
    expect(await service.signal(id, 'other', 1)).to.deep.equal({ accepted: true });
    expect((await instance(id)).Status).to.equal('waiting');
    const before = (await instance(id)).Attempt;
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Attempt')).to.deep.equal({ Status: 'waiting', Attempt: before });
    // an event that landed while the instance was being parked is found by the signalled scan through the key range
    await seedEvent(id, 'reject', { Payload: 'late' });
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'reject' });
  });

  it('a race of a wait and a 1d sleep parks waiting until the sleep, and a signal wins it', async () => {
    const { id } = await service.start('pk-wait-or-sleep', null);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WaitingFor', 'WakeAt')).to.deep.equal({ Status: 'waiting', WaitingFor: 'approve', WakeAt: T0 + DAY });
    await service.signal(id, 'approve', 'x');
    clock.set(T0 + HOUR);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'approve' });
  });

  it('the 1d sleep wins the race when nothing is signalled', async () => {
    const { id } = await service.start('pk-wait-or-sleep', null);
    await r1.tick();
    clock.set(T0 + DAY);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'timeout' });
  });

  it('a signal buffered before the race wins it in the first activation', async () => {
    const { id } = await service.start('pk-wait-or-sleep', null);
    await service.signal(id, 'approve', 'x');
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'approve' });
  });

  it('a race of a 1d sleep and two sequential steps finishes the steps in the first activation', async () => {
    const { id } = await service.start('pk-sleep-or-work', null);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'work' });
    expect((await stepsOf(id)).map((s) => s.Key)).to.deep.equal(['step:w1#1', 'sleep:sleep#1', 'step:w2#1']);
  });

  it('a fan-out whose branches each run a step and sleep 1h: every sleep is taken in the first activation and none fires late', async () => {
    for (let run = 0; run < 3; run++) {
      const { id } = await service.start('pk-fan-sleep', null, { id: `fan-${run}` });
      clock.set(T0);
      await r1.tick();
      expect(pick(await instance(id), 'Status', 'WakeAt')).to.deep.equal({ Status: 'sleeping', WakeAt: T0 + HOUR });
      const sleeps = (await stepsOf(id)).filter((s) => s.Kind === 'sleep');
      expect(sleeps.map((s) => [s.Status, s.Meta?.wakeAt])).to.deep.equal([
        ['pending', T0 + HOUR],
        ['pending', T0 + HOUR],
        ['pending', T0 + HOUR],
      ]);
      clock.set(T0 + HOUR);
      await r1.tick();
      expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: [0, 10, 20] });
    }
  });
});
