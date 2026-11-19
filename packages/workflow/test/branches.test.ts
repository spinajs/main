import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { branchId, type ActivationContext } from '../src/index.js';
import { activation } from './support/activation.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import { rejects, seedInstance, stepsOf } from './support/rows.js';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Orders branches by an event of the run: a sleep loses to a slow journal write on a loaded machine. */
function latch(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('explicit branches', () => {
  beforeEach(async () => {
    await bootTestEnv();
    await seedInstance('br1');
  });
  after(disposeTestEnv);

  it('ctx.all keeps each item on its own results, although every branch awaits non-durable work first', async () => {
    // the slow item makes its first durable call only after the other one has
    const code = (ctx: ActivationContext, slowId: string) => {
      const otherCharging = latch();
      return ctx.enter(() =>
        ctx.all(['x', 'y'], async (id) => {
          await (id === slowId ? otherCharging.wait : pause(0));
          const charged = ctx.step('charge', () => `charged ${id}`);
          if (id !== slowId) otherCharging.open();
          return charged;
        }),
      );
    };
    const first = await activation('br1');
    const live = await code(first.ctx, 'y');
    await first.release();
    const replay = await activation('br1');
    const replayed = await code(replay.ctx, 'x');
    const unvisited = replay.journal.unvisited();
    await replay.release();
    expect([live, replayed, unvisited]).to.deep.equal([['charged x', 'charged y'], ['charged x', 'charged y'], []]);
    expect((await stepsOf('br1')).map((s) => [s.Key, s.Meta?.call])).to.deep.equal([
      [`step:charge#1@${branchId('', 'branch:all:0#1')}`, 1],
      [`step:charge#1@${branchId('', 'branch:all:1#1')}`, 1],
    ]);
  });

  it('the code after ctx.all and after a race over ctx.branch stays in the branch of the caller', async () => {
    const h = await activation('br1');
    const quickDone = latch();
    await h.ctx.enter(async () => {
      await h.ctx.all([1, 2], (n) => h.ctx.step('load', () => n));
      await h.ctx.step('after-all', () => 'a');
      const slow = h.ctx.branch('slow', async () => {
        await h.ctx.step('s', () => 's');
        await quickDone.wait;
        return h.ctx.step('t', () => 't');
      });
      await Promise.race([
        slow,
        h.ctx.branch('quick', async () => {
          const s = await h.ctx.step('s', () => 'q');
          quickDone.open();
          return s;
        }),
      ]);
      await h.ctx.step('after-race', () => 'r');
      await slow;
    });
    await h.release();
    const slowBranch = branchId('', 'branch:slow#1');
    expect((await stepsOf('br1')).map((s) => [s.Key, s.Meta?.call])).to.have.deep.members([
      [`step:load#1@${branchId('', 'branch:all:0#1')}`, 1],
      [`step:load#1@${branchId('', 'branch:all:1#1')}`, 1],
      ['step:after-all#1', 1],
      [`step:s#1@${slowBranch}`, 1],
      [`step:s#1@${branchId('', 'branch:quick#1')}`, 1],
      ['step:after-race#1', 2],
      [`step:t#1@${slowBranch}`, 2],
    ]);
  });

  it('a name used again in the same branch of the caller names another branch, and nested branches derive from their own', async () => {
    const h = await activation('br1');
    await h.ctx.enter(async () => {
      for (const round of [1, 2]) await h.ctx.branch('round', () => h.ctx.step('work', () => round));
      await h.ctx.branch('outer', () => h.ctx.branch('inner', () => h.ctx.step('deep', () => 0)));
    });
    await h.release();
    expect((await stepsOf('br1')).map((s) => s.Key)).to.deep.equal([
      `step:work#1@${branchId('', 'branch:round#1')}`,
      `step:work#1@${branchId('', 'branch:round#2')}`,
      `step:deep#1@${branchId(branchId('', 'branch:outer#1'), 'branch:inner#1')}`,
    ]);
  });

  it('a step started in the same turn as a branch still forks: the code after them is in the branch after that step', async () => {
    const h = await activation('br1');
    await h.ctx.enter(async () => {
      await Promise.all([h.ctx.step('a', () => 'a'), h.ctx.branch('b', () => h.ctx.step('x', () => 'x'))]);
      await h.ctx.step('after', () => 'c');
    });
    await h.release();
    expect((await stepsOf('br1')).map((s) => s.Key)).to.have.members(['step:a#1', `step:x#1@${branchId('', 'branch:b#1')}`, `step:after#1@${branchId('', 'step:a#1')}`]);
  });

  it('ctx.branch around each task of a limiter keeps every task on its own keys, whatever finishes first', async () => {
    /** At most two tasks at a time; a queued task starts where the one before it finished, as in p-limit. */
    const limiter = () => {
      let active = 0;
      const queue: (() => void)[] = [];
      const next = (): void => {
        if (active < 2) queue.shift()?.();
      };
      return <T>(task: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          queue.push(() => {
            active++;
            void task()
              .then(resolve, reject)
              .finally(() => {
                active--;
                next();
              });
          });
          queueMicrotask(next);
        });
    };
    const ids = ['w', 'x', 'y', 'z'];
    // the slow task calls save only after another task has; a replay hands results back in recorded order, so the
    // latch opens at the call, not at its result
    const code = (ctx: ActivationContext, slowId: string) =>
      ctx.enter(() => {
        const limit = limiter();
        const otherSaving = latch();
        return Promise.all(
          ids.map((id) =>
            limit(() =>
              ctx.branch(`item:${id}`, async () => {
                const fetched = await ctx.step('fetch', () => id);
                if (id === slowId) await otherSaving.wait;
                const saved = ctx.step('save', () => `saved ${fetched}`);
                if (id !== slowId) otherSaving.open();
                return saved;
              }),
            ),
          ),
        );
      });
    const first = await activation('br1');
    const live = await code(first.ctx, 'w');
    await first.release();
    const replay = await activation('br1');
    const replayed = await code(replay.ctx, 'x');
    const unvisited = replay.journal.unvisited();
    await replay.release();
    const saved = ids.map((id) => `saved ${id}`);
    expect([live, replayed, unvisited]).to.deep.equal([saved, saved, []]);
    expect((await stepsOf('br1')).map((s) => s.Key)).to.have.members(ids.flatMap((id) => [`step:fetch#1@${branchId('', `branch:item:${id}#1`)}`, `step:save#1@${branchId('', `branch:item:${id}#1`)}`]));
  });

  it('ctx.all with a concurrency bound runs that many branches at a time and keeps each item on the branch of its index', async () => {
    let running = 0;
    let peak = 0;
    // the slow item calls charge only after another item has
    const code = (ctx: ActivationContext, slowId: string) => {
      const otherCharging = latch();
      return ctx.enter(() =>
        ctx.all(
          ['w', 'x', 'y', 'z'],
          async (id) => {
            peak = Math.max(peak, ++running);
            await (id === slowId ? otherCharging.wait : pause(0));
            const charging = ctx.step('charge', () => `charged ${id}`);
            if (id !== slowId) otherCharging.open();
            const charged = await charging;
            running--;
            return charged;
          },
          { concurrency: 2 },
        ),
      );
    };
    const first = await activation('br1');
    const live = await code(first.ctx, 'w');
    await first.release();
    const replay = await activation('br1');
    const replayed = await code(replay.ctx, 'x');
    const unvisited = replay.journal.unvisited();
    await replay.release();
    const charged = ['charged w', 'charged x', 'charged y', 'charged z'];
    expect([live, replayed, unvisited, peak]).to.deep.equal([charged, charged, [], 2]);
    expect((await stepsOf('br1')).map((s) => s.Key)).to.have.members([0, 1, 2, 3].map((i) => `step:charge#1@${branchId('', `branch:all:${i}#1`)}`));
  });

  it('refuses a concurrency that is not an integer of at least 1, before any branch runs', async () => {
    const h = await activation('br1');
    let ran = 0;
    for (const concurrency of [0, 1.5]) expect(await rejects(h.ctx.all([1, 2], () => ++ran, { concurrency }))).to.be.instanceOf(InvalidArgument);
    await h.release();
    expect(ran).to.equal(0);
  });

  it('refuses a name that could not be a step name, and hands back what fn throws', async () => {
    const h = await activation('br1');
    expect(await rejects(h.ctx.branch(' padded', () => 1))).to.be.instanceOf(InvalidArgument);
    const boom = new Error('boom');
    expect(
      await rejects(
        h.ctx.branch('throws', () => {
          throw boom;
        }),
      ),
    ).to.equal(boom);
    await h.release();
  });
});
