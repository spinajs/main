import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { readFile } from 'node:fs/promises';
import sinon from 'sinon';
import { Clock, FaultInjector, NonRetryableError } from '@spinajs/durable';
import type { FakeClock } from '@spinajs/durable/testing';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { ReplayGate } from '../src/gate.js';
import { NonDeterminismError, resolveWorkflowConfig, type ActivationContext, type Op, type StepRow, WorkflowAborted, WorkflowFailure, WorkflowStepFailed } from '../src/index.js';
import { activation } from './support/activation.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import { TestCrash, TestFaults } from './support/faults.js';
import { eventsOf, expireLease, instance, pick, rejects, seedEvent, seedInstance, seedStep, stepsOf, T0, takeOver } from './support/rows.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ActivationContext: steps and replay', () => {
  beforeEach(async () => {
    TestFaults.reset();
    await bootTestEnv({ register: () => DI.register(TestFaults).as(FaultInjector) });
    await seedInstance('c1');
  });
  after(disposeTestEnv);

  it('journals a step as step:<name>#1 and returns its value', async () => {
    const h = await activation('c1');
    let calls = 0;
    const value = await h.ctx.step('charge', () => {
      calls++;
      return { total: 42 };
    });
    await h.release();
    expect([value, calls]).to.deep.equal([{ total: 42 }, 1]);
    const [row] = await stepsOf('c1');
    expect(pick(row, 'Seq', 'Key', 'Kind', 'Status', 'Attempt', 'ResultStored', 'StartedAt', 'FinishedAt', 'Result')).to.deep.equal({
      Seq: 1,
      Key: 'step:charge#1',
      Kind: 'step',
      Status: 'succeeded',
      Attempt: 1,
      ResultStored: true,
      StartedAt: T0,
      FinishedAt: T0,
      Result: { total: 42 },
    });
  });

  it('replays a recorded step from the journal without running it again', async () => {
    const first = await activation('c1');
    await first.ctx.step('charge', () => 'paid');
    await first.release();
    const second = await activation('c1');
    let calls = 0;
    const value = await second.ctx.step('charge', () => {
      calls++;
      return 'again';
    });
    await second.release();
    expect([value, calls, (await stepsOf('c1')).length]).to.deep.equal(['paid', 0, 1]);
  });

  it('counts repeated names: step:x#1, step:y#1, step:x#2', async () => {
    const h = await activation('c1');
    await h.ctx.step('x', () => 1);
    await h.ctx.step('y', () => 2);
    await h.ctx.step('x', () => 3);
    await h.release();
    expect((await stepsOf('c1')).map((s) => [s.Seq, s.Key])).to.deep.equal([
      [1, 'step:x#1'],
      [2, 'step:y#1'],
      [3, 'step:x#2'],
    ]);
  });

  it('hands back the stored JSON form, on the first run and on replay alike', async () => {
    const first = await activation('c1');
    const value = await first.ctx.step('stamp', () => ({ at: new Date(T0) }));
    await first.release();
    const second = await activation('c1');
    const replayed = await second.ctx.step('stamp', () => ({ at: new Date(0) }));
    await second.release();
    expect(value).to.deep.equal({ at: new Date(T0).toISOString() });
    expect(replayed).to.deep.equal(value);
  });

  it('persistResult false: nothing is stored and a replay resolves undefined without running', async () => {
    const first = await activation('c1');
    expect(await first.ctx.step('secret', () => 'token', { persistResult: false })).to.equal('token');
    await first.release();
    expect(pick((await stepsOf('c1'))[0], 'Status', 'ResultStored', 'Result')).to.deep.equal({ Status: 'succeeded', ResultStored: false, Result: null });
    const second = await activation('c1');
    let calls = 0;
    const replayed = await second.ctx.step(
      'secret',
      () => {
        calls++;
        return 'again';
      },
      { persistResult: false },
    );
    await second.release();
    expect([replayed, calls]).to.deep.equal([undefined, 0]);
  });

  /** Runs `code` live, then as a replay of what it journaled. */
  const twice = async <T>(code: (ctx: ActivationContext) => Promise<T>, id = 'c1') => {
    const first = await activation(id);
    const live = await code(first.ctx);
    await first.release();
    const replay = await activation(id);
    const replayed = await code(replay.ctx);
    const unvisited = replay.journal.unvisited();
    await replay.release();
    return { live, replayed, unvisited };
  };

  it('concurrent branches with different names replay at their recorded positions', async () => {
    const branch = (ctx: ActivationContext, first: string, second: string, ms: number) => ctx.step(first, () => pause(ms)).then(() => ctx.step(second, () => second));
    const r = await twice((ctx) => Promise.all([branch(ctx, 'a', 'c', 50), branch(ctx, 'b', 'd', 0)]));
    expect((await stepsOf('c1')).map((s) => `${s.Seq}:${s.Key}`)).to.deep.equal(['1:step:a#1', '2:step:b#1', '3:step:d#1', '4:step:c#1']);
    expect([r.replayed, r.unvisited]).to.deep.equal([['c', 'd'], []]);
  });

  it('same-name branches keep their own results on replay, whatever their timing', async () => {
    const branch = (ctx: ActivationContext, id: string, ms: number) => ctx.step('fetch', () => pause(ms).then(() => id)).then(() => ctx.step('save', () => `saved ${id}`));
    const r = await twice((ctx) => Promise.all([branch(ctx, 'x', 50), branch(ctx, 'y', 0)]));
    expect([r.live, r.replayed]).to.deep.equal([
      ['saved x', 'saved y'],
      ['saved x', 'saved y'],
    ]);
  });

  it('three same-name branches of three steps keep their own results', async () => {
    const branch = async (ctx: ActivationContext, id: string, delays: number[]) => {
      const out: string[] = [];
      for (const [name, ms] of [
        ['fetch', delays[0]],
        ['check', delays[1]],
        ['save', delays[2]],
      ] as const)
        out.push(await ctx.step(name, () => pause(ms).then(() => `${name} ${id}`)));
      return out;
    };
    const r = await twice((ctx) => Promise.all([branch(ctx, 'x', [30, 0, 10]), branch(ctx, 'y', [0, 25, 0]), branch(ctx, 'z', [12, 3, 20])]));
    expect([r.replayed, r.unvisited]).to.deep.equal([r.live, []]);
  });

  it('same-name branches of different lengths replay in their original interleaving', async () => {
    const r = await twice((ctx) =>
      Promise.all([
        ctx.step('a', () => pause(50)).then(() => ctx.step('save', () => 'a')),
        ctx
          .step('b', () => 0)
          .then(() => ctx.step('c', () => 0))
          .then(() => ctx.step('save', () => 'b')),
      ]),
    );
    expect([r.replayed, r.unvisited]).to.deep.equal([['a', 'b'], []]);
  });

  const hops: Record<string, () => Promise<unknown>> = {
    'one setImmediate': () => new Promise((resolve) => setImmediate(resolve)),
    'two setImmediate': () => new Promise((resolve) => setImmediate(() => setImmediate(resolve))),
    'a setTimeout(0)': () => pause(0),
    'an awaited file read': () => readFile('package.json'),
  };
  for (const [label, hop] of Object.entries(hops)) {
    it(`same-name branches keep their own results with ${label} between steps`, async () => {
      const branch = async (ctx: ActivationContext, id: string, ms: number) => {
        const fetched = await ctx.step('fetch', () => pause(ms).then(() => `fetch ${id}`));
        if (id === 'x') await hop();
        return [fetched, await ctx.step('save', () => `save ${id}`)];
      };
      for (let n = 0; n < 5; n++) {
        await seedInstance(`h${n}`);
        const r = await twice((ctx) => Promise.all([branch(ctx, 'x', 0), branch(ctx, 'y', 1)]), `h${n}`);
        expect(r.replayed).to.deep.equal([
          ['fetch x', 'save x'],
          ['fetch y', 'save y'],
        ]);
      }
    });
  }

  it('recorded results do not wait for a live step that runs alongside them', async () => {
    TestFaults.crashOnce('workflow.after-step-fn', 'step:long');
    const first = await activation('c1');
    await Promise.allSettled([first.ctx.step('long', () => pause(100)), first.ctx.step('a', () => pause(50).then(() => 'a')), first.ctx.step('b', () => 'b')]);
    await first.ctx.drain();
    await expireLease('c1');
    TestFaults.reset();
    const replay = await activation('c1');
    const settled: string[] = [];
    const live = replay.ctx.step('long', () => pause(300)).then(() => settled.push('live'));
    const recorded = Promise.all([replay.ctx.step('a', () => 'A'), replay.ctx.step('b', () => 'B')]).then((v) => settled.push(v.join()));
    await Promise.all([live, recorded]);
    await replay.release();
    expect(settled).to.deep.equal(['a,b', 'live']);
  });

  it('a step inserted into sequential code is non-deterministic before its body runs', async () => {
    const first = await activation('c1');
    await first.ctx.step('a', () => 'a');
    await first.ctx.step('b', () => 'b');
    await first.release();
    const replay = await activation('c1');
    let ran = 0;
    await replay.ctx.step('a', () => 'a');
    const err = await rejects(replay.ctx.step('inserted', () => ++ran));
    await replay.release();
    expect([err.message, ran, replay.ctx.interruption?.kind]).to.deep.equal(["the journal recorded 'step:b#1' at position 2, this run asked for 'step:inserted#1'", 0, 'nondeterminism']);
  });

  it('a replay waiting for a recorded step the code no longer calls fails when the stall timer fires', async () => {
    const first = await activation('c1');
    await Promise.all([first.ctx.step('x1', () => 1).then(() => first.ctx.step('x2', () => 2)), first.ctx.step('y1', () => pause(30))]);
    await first.release();
    const replay = await activation('c1');
    const pending = rejects(Promise.all([replay.ctx.step('x1', () => 1), replay.ctx.step('y1', () => 0)]));
    await ((await DI.resolve(Clock)) as FakeClock).advance(60_000);
    const err = await pending;
    await replay.release();
    expect([err.message, replay.ctx.interruption?.kind]).to.deep.equal(["the replay is waiting for 'step:x2#1', which the journal recorded and this run has not asked for", 'nondeterminism']);
  });

  it('replays under sinon.useFakeTimers() without waiting on a timer', async () => {
    const first = await activation('c1');
    await first.ctx.step('a', () => 1);
    await first.ctx.step('b', () => 2);
    await first.release();
    const replay = await activation('c1');
    const timers = sinon.useFakeTimers();
    try {
      expect([await replay.ctx.step('a', () => 0), await replay.ctx.step('b', () => 0)]).to.deep.equal([1, 2]);
    } finally {
      timers.restore();
    }
    await replay.release();
  });

  it('a Promise.race between a step with a continuation and a bare step picks the same winner on replay', async () => {
    const r = await twice(async (ctx) => {
      const parsed = ctx.step('primary', () => pause(5).then(() => 'primary')).then((v) => v.toUpperCase());
      const fallback = ctx.step('fallback', () => pause(40).then(() => 'fallback'));
      const winner = await Promise.race([parsed, fallback]);
      await Promise.allSettled([parsed, fallback]);
      return winner;
    });
    expect([r.live, r.replayed]).to.deep.equal(['PRIMARY', 'PRIMARY']);
  });

  it('branches that push their results as they finish push them in the same order on replay', async () => {
    const r = await twice(async (ctx) => {
      const done: string[] = [];
      await Promise.all([
        ctx
          .step('a', () => pause(5).then(() => 'a'))
          .then(async (v) => {
            await null;
            await null;
            return done.push(v);
          }),
        ctx.step('b', () => pause(40).then(() => 'b')).then((v) => done.push(v)),
      ]);
      return done.join();
    });
    expect([r.live, r.replayed]).to.deep.equal(['a,b', 'a,b']);
  });

  it('per-item step names replay even when the waits between steps take different times than the first run', async () => {
    const code = (xMs: number, yMs: number) => (ctx: ActivationContext) =>
      Promise.all([
        ctx
          .step('quote', () => 'q')
          .then(async () => {
            await pause(xMs);
            return ctx.step('book', () => 'booked');
          }),
        ctx
          .step('profile', () => pause(3).then(() => 'p'))
          .then(async () => {
            await pause(yMs);
            return ctx.step('notify', () => 'notified');
          }),
      ]);
    const first = await activation('c1');
    const live = await code(80, 5)(first.ctx);
    await first.release();
    const replay = await activation('c1');
    expect(await code(20, 120)(replay.ctx)).to.deep.equal(live);
    await replay.release();
  });

  it('a step lost in a crash that completes during the replay keeps its result behind the recorded ones', async () => {
    const code = (ctx: ActivationContext, bMs: number) =>
      Promise.all([
        ctx
          .step('a', () => 'a')
          .then(async () => {
            await pause(60);
            return ctx.step('c', () => 'c');
          })
          .then(async () => {
            await pause(10);
            return ctx.step('e', () => 'e');
          }),
        ctx.step('b', () => pause(bMs).then(() => 'b')),
      ]);
    TestFaults.crashOnce('workflow.after-step-fn', 'step:b');
    const crashed = await activation('c1');
    await Promise.allSettled([code(crashed.ctx, 400)]);
    await crashed.ctx.drain();
    await expireLease('c1');
    TestFaults.reset();
    const r = await twice((ctx) => code(ctx, 5));
    expect([r.live, r.replayed]).to.deep.equal([
      ['e', 'b'],
      ['e', 'b'],
    ]);
  });

  it('a NonDeterminismError in one branch settles the other branches at once, without a stall timer', async () => {
    const code = (renamed: boolean) => (ctx: ActivationContext) => Promise.all([ctx.step('a', () => 'a').then(() => ctx.step(renamed ? 'c2' : 'c', () => 'c')), ctx.step('b', () => pause(50).then(() => 'b'))]);
    const first = await activation('c1', { timers: undefined });
    await code(false)(first.ctx);
    await first.release();
    const replay = await activation('c1', { timers: undefined });
    expect(await rejects(code(true)(replay.ctx))).to.be.instanceOf(NonDeterminismError);
    const t0 = Date.now();
    await replay.release();
    expect([Date.now() - t0 < 1000, replay.ctx.interruption?.kind]).to.deep.equal([true, 'nondeterminism']);
  });

  it('ctx.fail in one branch settles a branch waiting for a release and stays the interruption', async () => {
    const code = (xMs: number, yMs: number) => (ctx: ActivationContext) =>
      Promise.all([
        ctx
          .step('a', () => 'a')
          .then(async () => {
            await pause(xMs);
            return ctx.fail('over limit');
          }),
        ctx
          .step('b', () => 'b')
          .then(async () => {
            await pause(yMs);
            return ctx.step('c', () => 'c');
          }),
        ctx.step('d', () => pause(30).then(() => 'd')),
      ]);
    const first = await activation('c1', { timers: undefined });
    await rejects(code(60, 5)(first.ctx));
    await first.release();
    const replay = await activation('c1', { timers: undefined });
    expect(await rejects(code(5, 60)(replay.ctx))).to.be.instanceOf(WorkflowFailure);
    const t0 = Date.now();
    await replay.release();
    expect([Date.now() - t0 < 1000, replay.ctx.interruption?.kind]).to.deep.equal([true, 'fail']);
  });

  it('releases 10 000 recorded results well within two seconds', async () => {
    const row = (seq: number, key: string, after: number): StepRow => ({ Id: seq, Seq: seq, Key: key, Kind: 'step', Status: 'succeeded', Attempt: 1, Result: null, ResultStored: false, Error: null, Meta: { after, order: seq } });
    const n = 5000;
    const items = Array.from({ length: n }, (_, i) => i);
    const gate = new ReplayGate([...items.map((i) => row(i + 1, `step:fetch-${i}#1`, 0)), ...items.map((i) => row(n + i + 1, `step:save-${i}#1`, n))], true, () => undefined);
    const t0 = Date.now();
    const replay = (kind: string) =>
      Promise.all(
        items.map((i) => {
          gate.call(`step:${kind}-${i}#1`);
          return gate.wait(`step:${kind}-${i}#1`);
        }),
      );
    await replay('fetch');
    await replay('save');
    expect([gate.delivered, Date.now() - t0 < 2000]).to.deep.equal([2 * n, true]);
  });

  it('refuses to journal a row without Meta.after into a journal that carries it', async () => {
    const h = await activation('c1');
    const ctx = h.ctx as unknown as { saveStep(op: Op, s: unknown): Promise<unknown> };
    const op: Op = { kind: 'step', name: 'x', key: 'step:x#1', seq: 1, after: Number.NaN };
    expect(await rejects(ctx.saveStep(op, { status: 'succeeded', attempt: 1, startedAt: T0, finished: true }))).to.be.instanceOf(InvalidOperation);
    await h.release();
    expect((await stepsOf('c1')).length).to.equal(0);
  });

  it('updating a journal row that no longer exists fails instead of passing silently', async () => {
    const h = await activation('c1');
    const gone = { Id: 9999, Seq: 1, Key: 'step:x#1', Kind: 'step', Status: 'succeeded', Attempt: 1, Result: null, ResultStored: false, Error: null, Meta: null } satisfies StepRow;
    const write = { instanceId: 'c1', seq: 1, key: 'step:x#1', kind: 'step', status: 'failed', attempt: 1, startedAt: T0, finishedAt: T0 } as const;
    expect(await rejects(h.store.saveStep(gone, write))).to.be.instanceOf(InvalidOperation);
    await h.release();
  });

  it('another occurrence of the same name at a recorded position is non-deterministic, and stays so', async () => {
    await seedStep('c1', 1, 'step:a#1');
    await seedStep('c1', 2, 'step:a#2');
    const h = await activation('c1');
    await h.ctx.step('x', () => 1);
    const err = await rejects(h.ctx.step('a', () => 1));
    expect(err).to.be.instanceOf(NonDeterminismError);
    expect(err.message).to.equal("the journal recorded 'step:a#2' at position 2, this run asked for 'step:a#1'");
    expect([h.ctx.interruption?.kind, h.journal.unvisited()]).to.deep.equal(['nondeterminism', ['step:a#2']]);
    expect(await rejects(h.ctx.step('a', () => 1))).to.equal(err);
    await h.release();
  });

  it('an occurrence of a repeated name asked for at another position is non-deterministic', async () => {
    await seedStep('c1', 1, 'step:a#1');
    await seedStep('c1', 2, 'step:b#1');
    await seedStep('c1', 3, 'step:a#2');
    const h = await activation('c1');
    await h.ctx.step('a', () => 1);
    const err = await rejects(h.ctx.step('a', () => 1));
    expect(err).to.be.instanceOf(NonDeterminismError);
    expect(err.message).to.equal("the journal recorded 'step:a#2' at position 3, this run asked for it at 2");
    await h.release();
  });

  it('refuses a durable operation inside a step, names longer than 128 characters and edge whitespace', async () => {
    const h = await activation('c1');
    const err = (await rejects(h.ctx.step('outer', () => h.ctx.step('inner', () => 1)))) as WorkflowStepFailed;
    expect(err).to.be.instanceOf(WorkflowStepFailed);
    expect([err.errorName, err.error.message]).to.deep.equal(['WorkflowNestingError', "'inner' (step) was called inside step 'outer'; durable operations cannot nest"]);
    expect(await rejects(h.ctx.step('n'.repeat(129), () => 1))).to.be.instanceOf(InvalidArgument);
    expect(await rejects(h.ctx.step('pay ', () => 1))).to.be.instanceOf(InvalidArgument);
    await h.release();
  });

  it('a step that fails for good is journaled failed and replays as WorkflowStepFailed without running', async () => {
    const first = await activation('c1');
    const err1 = (await rejects(
      first.ctx.step('charge', () => {
        throw new NonRetryableError('card declined');
      }),
    )) as WorkflowStepFailed;
    await first.release();
    expect([err1.step, err1.errorName, err1.message]).to.deep.equal(['charge', 'NonRetryableError', "step 'charge' failed: card declined"]);
    expect(err1.original).to.be.instanceOf(NonRetryableError);
    const [row] = await stepsOf('c1');
    expect(pick(row, 'Status', 'Attempt')).to.deep.equal({ Status: 'failed', Attempt: 1 });
    expect(pick(row.Error!, 'name', 'message', 'step')).to.deep.equal({ name: 'NonRetryableError', message: 'card declined', step: 'charge' });

    const second = await activation('c1');
    let calls = 0;
    const err2 = (await rejects(
      second.ctx.step('charge', () => {
        calls++;
      }),
    )) as WorkflowStepFailed;
    await second.release();
    expect([calls, err2.errorName, err2.message, err2.original]).to.deep.equal([0, 'NonRetryableError', "step 'charge' failed: card declined", undefined]);
  });

  it("transactional: the step's own writes and its journal row commit together", async () => {
    const h = await activation('c1');
    await h.ctx.step(
      'book',
      async () => {
        await seedEvent('side', 'booked');
        return 'ok';
      },
      { transactional: true },
    );
    await h.release();
    expect((await eventsOf('side')).length).to.equal(1);
    expect((await stepsOf('c1')).map((s) => s.Key)).to.deep.equal(['step:book#1']);
  });

  it("transactional: a lost lease rolls the step's writes back", async () => {
    const h = await activation('c1');
    await takeOver('c1');
    const err = (await rejects(
      h.ctx.step(
        'book',
        async () => {
          await seedEvent('side', 'booked');
          return 'ok';
        },
        { transactional: true },
      ),
    )) as WorkflowAborted;
    expect(err).to.be.instanceOf(WorkflowAborted);
    expect([err.reason, h.abort.signal.reason]).to.deep.equal(['lease-lost', 'lease-lost']);
    expect((await eventsOf('side')).length).to.equal(0);
    expect((await stepsOf('c1')).length).to.equal(0);
  });

  it('a step whose journal write is fenced out keeps its side effect (at least once) and records nothing', async () => {
    const h = await activation('c1');
    await takeOver('c1');
    const err = (await rejects(
      h.ctx.step('book', async () => {
        await seedEvent('side', 'booked');
        return 'ok';
      }),
    )) as WorkflowAborted;
    expect(err.reason).to.equal('lease-lost');
    expect((await eventsOf('side')).length).to.equal(1);
    expect((await stepsOf('c1')).length).to.equal(0);
  });

  it('a journal write that fails for another reason abandons the activation instead of failing the step', async () => {
    TestFaults.failure = (point) => (point === 'workflow.before-journal' ? new Error('database is away') : undefined);
    const h = await activation('c1');
    const err = (await rejects(h.ctx.step('charge', () => 'paid'))) as WorkflowAborted;
    expect([err.reason, h.abort.signal.reason, (await stepsOf('c1')).length]).to.deep.equal(['journal-failed', 'journal-failed', 0]);
    expect(((await rejects(h.ctx.step('next', () => 1))) as WorkflowAborted).reason).to.equal('journal-failed');
  });

  it('a crash thrown by a step body writes nothing and releases nothing', async () => {
    const h = await activation('c1');
    const crash = new TestCrash('body');
    const err = await rejects(
      h.ctx.step('charge', () => {
        throw crash;
      }),
    );
    expect([err, h.ctx.crashed, (await stepsOf('c1')).length, (await instance('c1')).ClaimedBy]).to.deep.equal([crash, true, 0, 'r1']);
  });

  it('a crash at a fault point stops every write of the activation', async () => {
    TestFaults.crashOnce('workflow.after-step-fn', 'step:charge');
    const h = await activation('c1');
    expect(await rejects(h.ctx.step('charge', () => 'paid'))).to.be.instanceOf(TestCrash);
    expect([h.ctx.crashed, h.abort.signal.reason]).to.deep.equal([true, 'crashed']);
    expect((await stepsOf('c1')).length).to.equal(0);
    expect(((await rejects(h.ctx.step('next', () => 1))) as WorkflowAborted).reason).to.equal('crashed');
  });

  it('fail() throws WorkflowFailure and every later operation rethrows it', async () => {
    const h = await activation('c1');
    expect(() => h.ctx.fail('out of stock', { sku: 'A' })).to.throw(WorkflowFailure, 'out of stock');
    expect(h.ctx.interruption?.kind).to.equal('fail');
    expect(await rejects(h.ctx.step('x', () => 1))).to.be.instanceOf(WorkflowFailure);
    await h.release();
  });

  it('a value over workflow.maxStepResultBytes fails the step for good', async () => {
    const h = await activation('c1', { config: resolveWorkflowConfig({ maxStepResultBytes: 10 }) });
    const err = (await rejects(h.ctx.step('big', () => 'x'.repeat(50)))) as WorkflowStepFailed;
    await h.release();
    expect([err.errorName, err.error.message]).to.deep.equal(['WorkflowStepResultTooLarge', "step 'big' returned 52 bytes of JSON, over workflow.maxStepResultBytes (10)"]);
  });
});
