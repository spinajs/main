import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { FaultInjector, NonRetryableError } from '@spinajs/durable';
import { InvalidArgument } from '@spinajs/exceptions';
import { NonDeterminismError, resolveWorkflowConfig, type ActivationContext, WorkflowAborted, WorkflowFailure, WorkflowStepFailed } from '../src/index.js';
import { activation } from './support/activation.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import { TestCrash, TestFaults } from './support/faults.js';
import { eventsOf, instance, pick, rejects, seedEvent, seedInstance, seedStep, stepsOf, T0, takeOver } from './support/rows.js';

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

  it('concurrent branches replay in call order without a false non-determinism', async () => {
    const branch = (ctx: ActivationContext, first: string, second: string, ms: number) => ctx.step(first, () => pause(ms)).then(() => ctx.step(second, () => second));
    const first = await activation('c1');
    await Promise.all([branch(first.ctx, 'a', 'c', 50), branch(first.ctx, 'b', 'd', 0)]);
    await first.release();
    expect((await stepsOf('c1')).map((s) => `${s.Seq}:${s.Key}`)).to.deep.equal(['1:step:a#1', '2:step:b#1', '3:step:d#1', '4:step:c#1']);
    const replay = await activation('c1');
    expect(await Promise.all([branch(replay.ctx, 'a', 'c', 50), branch(replay.ctx, 'b', 'd', 0)])).to.deep.equal(['c', 'd']);
    expect(replay.journal.unvisited()).to.deep.equal([]);
    await replay.release();
  });

  it('same-name branches keep their own results on replay, whatever their timing', async () => {
    const branch = (ctx: ActivationContext, id: string, ms: number) => ctx.step('fetch', () => pause(ms).then(() => id)).then(() => ctx.step('save', () => `saved ${id}`));
    const run = (ctx: ActivationContext) => Promise.all([branch(ctx, 'x', 50), branch(ctx, 'y', 0)]);
    const first = await activation('c1');
    expect(await run(first.ctx)).to.deep.equal(['saved x', 'saved y']);
    await first.release();
    const replay = await activation('c1');
    expect(await run(replay.ctx)).to.deep.equal(['saved x', 'saved y']);
    await replay.release();
  });

  it('same-name branches of different lengths replay in their original interleaving', async () => {
    const run = (ctx: ActivationContext) =>
      Promise.all([
        ctx.step('a', () => pause(50)).then(() => ctx.step('save', () => 'a')),
        ctx
          .step('b', () => 0)
          .then(() => ctx.step('c', () => 0))
          .then(() => ctx.step('save', () => 'b')),
      ]);
    const first = await activation('c1');
    expect(await run(first.ctx)).to.deep.equal(['a', 'b']);
    await first.release();
    const replay = await activation('c1');
    expect([await run(replay.ctx), replay.journal.unvisited()]).to.deep.equal([['a', 'b'], []]);
    await replay.release();
  });

  it('a recorded result the code no longer asks for fails the replay with NonDeterminismError instead of hanging', async () => {
    const first = await activation('c1');
    await first.ctx.step('a', () => 1);
    await first.ctx.step('b', () => 2);
    await first.release();
    const replay = await activation('c1');
    const err = await rejects(replay.ctx.step('b', () => 2));
    expect([err.message, replay.ctx.interruption?.kind]).to.deep.equal(["the journal delivered 'step:a#1' before 'step:b#1', this run never asked for it", 'nondeterminism']);
    await replay.release();
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
