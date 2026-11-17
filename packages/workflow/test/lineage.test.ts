import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { FaultInjector } from '@spinajs/durable';
import type { FakeClock } from '@spinajs/durable/testing';
import { branchId, NonDeterminismError, Workflow, WorkflowDefinition, WorkflowService, type ActivationContext, type WorkflowContext } from '../src/index.js';
import { activation } from './support/activation.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import { TestFaults } from './support/faults.js';
import { expireLease, instance, pick, rejects, seedInstance, stepsOf, T0 } from './support/rows.js';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Which item's branch waits longer between its two steps; flipped between activations to change the timing of a replay. */
let slow = 'x';

@Workflow('ln-fan-out')
export class LnFanOut extends WorkflowDefinition<null, string[]> {
  public async run(ctx: WorkflowContext<null>): Promise<string[]> {
    const saved = await Promise.all(
      ['x', 'y'].map(async (id) => {
        const v = await ctx.step('fetch', () => id);
        await pause(id === slow ? 30 : 0);
        return ctx.step('save', () => `saved ${v}`);
      }),
    );
    await ctx.sleep('1m', 'settle');
    return saved;
  }
}

describe('branch-lineage keys', () => {
  let clock: FakeClock;

  beforeEach(async () => {
    slow = 'x';
    TestFaults.reset();
    ({ clock } = await bootTestEnv({ register: () => DI.register(TestFaults).as(FaultInjector) }));
    await seedInstance('ln1');
  });
  after(disposeTestEnv);

  it('implicit: pins the AsyncLocalStorage behaviour the keys rely on', async () => {
    const als = new AsyncLocalStorage<string>();
    const afterAwait: (string | undefined)[] = [];
    const afterThen: (string | undefined)[] = [];
    let leaked: string | undefined;
    const call = async (v: string): Promise<void> => {
      als.enterWith(v);
    };
    await als.run('root', async () => {
      const all = Promise.all(
        ['a', 'b'].map(async (v) => {
          await call(v);
          afterAwait.push(als.getStore());
        }),
      );
      leaked = als.getStore();
      await all;
      await Promise.all(['c', 'd'].map((v) => call(v).then(() => afterThen.push(als.getStore()))));
    });
    // the code after an await or a then resumes in the store its own call entered; the synchronous remainder sees the last one
    expect(afterAwait).to.deep.equal(['a', 'b']);
    expect(afterThen).to.deep.equal(['c', 'd']);
    expect(leaked).to.equal('b');
    expect(als.getStore()).to.equal(undefined);
  });

  it('keeps sequential keys as they were and numbers the calls', async () => {
    const h = await activation('ln1');
    await h.ctx.enter(async () => {
      await h.ctx.step('x', () => 1);
      await h.ctx.step('y', () => 2);
      await h.ctx.step('x', () => 3);
    });
    await h.release();
    expect((await stepsOf('ln1')).map((s) => [s.Key, s.Meta?.call])).to.deep.equal([
      ['step:x#1', 1],
      ['step:y#1', 2],
      ['step:x#2', 3],
    ]);
  });

  it('implicit: siblings are numbered in the branch of their caller, the code after them in its own', async () => {
    const h = await activation('ln1');
    await h.ctx.enter(async () => {
      await h.ctx.step('a', () => 'a');
      h.ctx.uuid();
      await Promise.all([h.ctx.step('b', () => 'b'), h.ctx.step('c', () => 'c')]);
      await h.ctx.step('d', () => 'd');
    });
    await h.release();
    expect((await stepsOf('ln1')).map((s) => [s.Key, s.Meta?.call])).to.deep.equal([
      ['step:a#1', 1],
      ['marker:uuid#1', 2],
      ['step:b#1', 3],
      ['step:c#1', 4],
      [`step:d#1@${branchId('', 'step:c#1')}`, 1],
    ]);
  });

  it('implicit: gives the code after a fork a branch of its own', async () => {
    const h = await activation('ln1');
    await h.ctx.enter(async () => {
      await Promise.all([h.ctx.step('a', () => 'a'), h.ctx.step('b', () => 'b')]);
      await h.ctx.step('c', () => 'c');
    });
    await h.release();
    expect((await stepsOf('ln1')).map((s) => s.Key)).to.deep.equal(['step:a#1', 'step:b#1', `step:c#1@${branchId('', 'step:b#1')}`]);
  });

  it('implicit: same-name steps with a non-durable await between them keep their own results when the replay timing differs', async () => {
    const code = (ctx: ActivationContext, slowId: string) =>
      ctx.enter(() =>
        Promise.all(
          ['x', 'y'].map(async (id) => {
            const v = await ctx.step('fetch', () => id);
            await pause(id === slowId ? 40 : 0);
            return ctx.step('save', () => `saved ${v}`);
          }),
        ),
      );
    const first = await activation('ln1');
    const live = await code(first.ctx, 'x');
    await first.release();
    const replay = await activation('ln1');
    const replayed = await code(replay.ctx, 'y');
    const unvisited = replay.journal.unvisited();
    await replay.release();
    expect(live).to.deep.equal(['saved x', 'saved y']);
    expect(replayed).to.deep.equal(['saved x', 'saved y']);
    expect(unvisited).to.deep.equal([]);
    expect((await stepsOf('ln1')).map((s) => s.Key)).to.deep.equal([
      'step:fetch#1',
      'step:fetch#2',
      `step:save#1@${branchId('', 'step:fetch#2')}`,
      `step:save#1@${branchId('', 'step:fetch#1')}`,
    ]);
  });

  it('implicit: a renamed call inside one branch is non-deterministic before its body runs', async () => {
    let ran = 0;
    const code = (ctx: ActivationContext, second: string) =>
      ctx.enter(() =>
        Promise.all(
          ['x', 'y'].map(async (id) =>
            ctx.step('fetch', () => id).then(() =>
              ctx.step(id === 'x' ? second : 'save', () => {
                ran++;
                return id;
              }),
            ),
          ),
        ),
      );
    const first = await activation('ln1');
    await code(first.ctx, 'save');
    await first.release();
    ran = 0;
    const replay = await activation('ln1');
    const err = await rejects(code(replay.ctx, 'store'));
    await replay.release();
    expect(err).to.be.instanceOf(NonDeterminismError);
    const x = branchId('', 'step:fetch#1');
    expect([err.message, ran]).to.deep.equal([`the journal recorded 'step:save#1@${x}' as call 1 of its branch, this run asked for 'step:store#1@${x}'`, 0]);
  });

  it('implicit: a marker in a forked branch replays its own value whatever the timing', async () => {
    const code = (ctx: ActivationContext, slowId: string) =>
      ctx.enter(() =>
        Promise.all(
          ['x', 'y'].map(async (id) => {
            await ctx.step('fetch', () => id);
            await pause(id === slowId ? 40 : 0);
            return `${id}:${ctx.uuid()}`;
          }),
        ),
      );
    const first = await activation('ln1');
    const live = await code(first.ctx, 'x');
    await first.release();
    const replay = await activation('ln1');
    const replayed = await code(replay.ctx, 'y');
    await replay.release();
    expect(replayed).to.deep.equal(live);
  });

  it('implicit: an engine replay with reversed timing completes with each branch on its own results', async () => {
    const service = await DI.resolve(WorkflowService);
    const { id } = await service.start('ln-fan-out', null);
    const r1 = await engine();
    await r1.tick();
    expect((await instance(id)).Status).to.equal('sleeping');
    slow = 'y';
    clock.set(T0 + 60_000);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: ['saved x', 'saved y'] });
  });

  it('implicit: a crash while the first sibling is still running leaves a hole the replay fills', async () => {
    const code = (ctx: ActivationContext, xMs: number) =>
      ctx.enter(() =>
        Promise.all(
          ['x', 'y'].map(async (id) => {
            const v = await ctx.step('fetch', () => pause(id === 'x' ? xMs : 0).then(() => id));
            return ctx.step('save', () => `saved ${v}`);
          }),
        ),
      );
    TestFaults.crashOnce('workflow.after-step-fn', 'step:fetch#1');
    const crashed = await activation('ln1');
    await Promise.allSettled([code(crashed.ctx, 80)]);
    await crashed.ctx.drain();
    // y finished while x was still fetching: call 1 of the root branch was never journaled
    expect((await stepsOf('ln1')).map((s) => [s.Key, s.Meta?.call])).to.deep.equal([
      ['step:fetch#2', 2],
      [`step:save#1@${branchId('', 'step:fetch#2')}`, 1],
    ]);
    await expireLease('ln1');
    TestFaults.reset();
    const replay = await activation('ln1');
    const replayed = await code(replay.ctx, 0);
    const unvisited = replay.journal.unvisited();
    await replay.release();
    expect([replayed, unvisited, replay.ctx.interruption]).to.deep.equal([['saved x', 'saved y'], [], null]);
  });

  it('implicit: a branch continued by a later activation replays, although its new row has a lower Seq than the row before it', async () => {
    const code = (ctx: ActivationContext, slowId: string) =>
      ctx.enter(() =>
        Promise.all(
          ['x', 'y'].map(async (id) => {
            await ctx.step('fetch', () => id);
            if (id === 'y') {
              await pause(slowId === 'y' ? 150 : 0);
              await Promise.all([ctx.step('load', () => pause(200)), ctx.step('scan', () => pause(200))]);
              return 'y done';
            }
            await pause(slowId === 'x' ? 60 : 0);
            const saved = await ctx.step('save', () => 'saved x');
            return ctx.step('ship', () => `shipped ${saved}`);
          }),
        ),
      );
    const X = branchId('', 'step:fetch#1');
    // activation 1: y's two steps are in flight (Seq 3 and 4) when x saves (Seq 5) and crashes in ship
    TestFaults.crashOnce('workflow.after-step-fn', 'step:ship');
    const crashed = await activation('ln1');
    await Promise.allSettled([code(crashed.ctx, 'x')]);
    await crashed.ctx.drain();
    await expireLease('ln1');
    TestFaults.reset();
    // activation 2: x goes first, so its ship takes Seq 4, below the Seq 5 its save recorded
    const second = await activation('ln1');
    const done = await code(second.ctx, 'y');
    await second.release();
    const ofX = (await stepsOf('ln1')).filter((s) => s.Key.endsWith(`@${X}`));
    expect(ofX.map((s) => [s.Key, s.Seq, s.Meta?.call])).to.deep.equal([
      [`step:ship#1@${X}`, 4, 2],
      [`step:save#1@${X}`, 5, 1],
    ]);
    // activation 3: a full replay with the first timing again
    const third = await activation('ln1');
    const replayed = await code(third.ctx, 'x');
    const unvisited = third.journal.unvisited();
    await third.release();
    expect([done, replayed, unvisited, third.ctx.interruption]).to.deep.equal([['shipped saved x', 'y done'], ['shipped saved x', 'y done'], [], null]);
  });

  it('implicit: the code after a race continues in the branch after the last sibling, pending or settled', async () => {
    const code = (ctx: ActivationContext, order: string[]) =>
      ctx.enter(async () => {
        await Promise.race(order.map((name) => ctx.step(name, () => pause(name === 'slow' ? 40 : 0))));
        return ctx.step('after', () => 'done');
      });
    await seedInstance('ln2');
    const pendingLast = await activation('ln1');
    await code(pendingLast.ctx, ['quick', 'slow']);
    await pendingLast.release();
    const settledLast = await activation('ln2');
    await code(settledLast.ctx, ['slow', 'quick']);
    await settledLast.release();
    expect((await stepsOf('ln1')).map((s) => s.Key)).to.include(`step:after#1@${branchId('', 'step:slow#1')}`);
    expect((await stepsOf('ln2')).map((s) => s.Key)).to.include(`step:after#1@${branchId('', 'step:quick#1')}`);
  });

  it('a name its branch recorded once may be called at another moment on replay', async () => {
    const code = (ctx: ActivationContext, slowId: string) =>
      ctx.enter(() =>
        Promise.all(
          ['x', 'y'].map(async (id) => {
            await pause(id === slowId ? 40 : 0);
            return ctx.step(`charge:${id}`, () => `charged ${id}`);
          }),
        ),
      );
    const first = await activation('ln1');
    await code(first.ctx, 'y');
    await first.release();
    const replay = await activation('ln1');
    const replayed = await code(replay.ctx, 'x');
    await replay.release();
    expect([replayed, replay.ctx.interruption]).to.deep.equal([['charged x', 'charged y'], null]);
  });

  // Not a guarantee: this pins what the README warns about, so that nobody documents it as safe.
  it('pins the open case: branches that await non-durable work before their first durable call are counted by timing', async () => {
    const code = (ctx: ActivationContext, slowId: string) =>
      ctx.enter(() =>
        Promise.all(
          ['x', 'y'].map(async (id) => {
            await pause(id === slowId ? 40 : 0);
            return ctx.step('charge', () => `charged ${id}`);
          }),
        ),
      );
    const first = await activation('ln1');
    const live = await code(first.ctx, 'y');
    await first.release();
    const replay = await activation('ln1');
    const replayed = await code(replay.ctx, 'x');
    await replay.release();
    expect(live).to.deep.equal(['charged x', 'charged y']);
    // x now receives what y's call recorded, and no error is raised
    expect([replayed, replay.ctx.interruption]).to.deep.equal([['charged y', 'charged x'], null]);
  });
});
