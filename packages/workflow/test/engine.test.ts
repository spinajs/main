import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { FaultInjector } from '@spinajs/durable';
import type { FakeClock } from '@spinajs/durable/testing';
import { Workflow, WorkflowDefinition, WorkflowEngine, WorkflowInstanceModel, WorkflowService, type WorkflowContext } from '../src/index.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv, waitFor } from './support/env.js';
import { TestCrash, TestFaults } from './support/faults.js';
import { deferred, expireLease, instance, pick, rejects, seedEvent, seedInstance, seedStep, stepsOf, T0 } from './support/rows.js';

const calls = { sum: 0, noop: 0, gated: 0 };
let gate = deferred<string>();
let started = deferred();

@Workflow('eng-sum')
export class EngSum extends WorkflowDefinition<{ a: number; b: number }, number> {
  public run(ctx: WorkflowContext<{ a: number; b: number }>): Promise<number> {
    return ctx.step('add', () => {
      calls.sum++;
      return ctx.input.a + ctx.input.b;
    });
  }
}

@Workflow('eng-noop')
export class EngNoop extends WorkflowDefinition<null, string> {
  public run(): Promise<string> {
    calls.noop++;
    return Promise.resolve('woke');
  }
}

@Workflow('eng-boom')
export class EngBoom extends WorkflowDefinition {
  public run(): Promise<never> {
    return Promise.reject(new RangeError('boom'));
  }
}

@Workflow('eng-dead')
export class EngDead extends WorkflowDefinition {
  public run(): Promise<never> {
    return Promise.reject(new TestCrash('run'));
  }
}

/** The first activation's step blocks on `gate`; any later one returns 'second'. */
@Workflow('eng-gated')
export class EngGated extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('work', () => {
      calls.gated++;
      if (calls.gated > 1) return 'second';
      started.resolve();
      return gate.promise;
    });
  }
}

@Workflow('eng-abortable')
export class EngAbortable extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('work', ({ signal }) => {
      started.resolve();
      return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    });
  }
}

/** Its warnings are captured whichever logger the process resolved first. */
class WarningsEngine extends WorkflowEngine {
  public static warnings: string[] = [];
  protected warn(message: string): void {
    WarningsEngine.warnings.push(message);
  }
}

@Workflow('eng-hb-crash')
export class EngHbCrash extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('work', () => {
      started.resolve();
      return gate.promise;
    });
  }
}

describe('WorkflowEngine.tick', () => {
  let service: WorkflowService;
  let clock: FakeClock;

  async function boot(workflow: Record<string, unknown> = {}): Promise<void> {
    TestFaults.reset();
    ({ clock } = await bootTestEnv({ workflow, register: () => DI.register(TestFaults).as(FaultInjector) }));
    service = await DI.resolve(WorkflowService);
  }

  beforeEach(() => {
    calls.sum = calls.noop = calls.gated = 0;
    gate = deferred<string>();
    started = deferred();
  });
  after(disposeTestEnv);

  it('claims a due instance, runs it to the end and releases the lease', async () => {
    await boot();
    const { id } = await service.start('eng-sum', { a: 2, b: 3 });
    await (await engine()).tick();
    expect(pick(await instance(id), 'Status', 'Result', 'ClaimedBy', 'ClaimEpoch', 'FinishedAt', 'Attempt', 'Reason')).to.deep.equal({
      Status: 'completed',
      Result: 5,
      ClaimedBy: null,
      ClaimEpoch: 1,
      FinishedAt: T0,
      Attempt: 1,
      Reason: null,
    });
    expect((await stepsOf(id)).map((s) => s.Key)).to.deep.equal(['step:add#1']);
  });

  it('clamps workflow.concurrency to 1 on SQLite, which runs one transaction at a time, and says so once', async () => {
    await boot({ concurrency: 2 });
    WarningsEngine.warnings = [];
    for (const id of ['n1', 'n2', 'n3']) await service.start('eng-noop', null, { id });
    await (await DI.resolve(WarningsEngine, [{ replicaId: 'r1' }])).tick();
    const statuses = await Promise.all(['n1', 'n2', 'n3'].map(async (id) => (await instance(id)).Status));
    expect(statuses.filter((s) => s === 'completed').length).to.equal(1);
    expect(calls.noop).to.equal(1);
    expect(WarningsEngine.warnings).to.deep.equal([
      "workflow.concurrency 2 clamped to 1: the 'orm-driver-sqlite' driver runs one transaction at a time, and a transactional step would stall every other activation's heartbeat",
    ]);
  });

  it('selects running, sleeping and waiting instances only when they are due', async () => {
    await boot();
    const past = T0 - 1;
    const future = T0 + 60_000;
    await seedInstance('run-now', { Workflow: 'eng-noop' });
    await seedInstance('run-later', { Workflow: 'eng-noop', WakeAt: future });
    await seedInstance('sleep-due', { Workflow: 'eng-noop', Status: 'sleeping', WakeAt: past });
    await seedInstance('sleep-later', { Workflow: 'eng-noop', Status: 'sleeping', WakeAt: future });
    await seedInstance('wait-signalled', { Workflow: 'eng-noop', Status: 'waiting', WaitingFor: 'go' });
    await seedEvent('wait-signalled', 'go');
    await seedInstance('wait-other', { Workflow: 'eng-noop', Status: 'waiting', WaitingFor: 'go' });
    await seedEvent('wait-other', 'stop');
    await seedInstance('wait-timeout', { Workflow: 'eng-noop', Status: 'waiting', WaitingFor: 'go', WakeAt: past });
    await seedInstance('done', { Workflow: 'eng-noop', Status: 'completed' });
    const r1 = await engine();
    // one activation per tick on SQLite: five ticks are more than the four due instances need, and the others stay put
    for (let i = 0; i < 5; i++) await r1.tick();
    const ids = ['run-now', 'run-later', 'sleep-due', 'sleep-later', 'wait-signalled', 'wait-other', 'wait-timeout', 'done'];
    const statuses = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await instance(id)).Status])));
    expect(statuses).to.deep.equal({
      'run-now': 'completed',
      'run-later': 'running',
      'sleep-due': 'completed',
      'sleep-later': 'sleeping',
      'wait-signalled': 'completed',
      'wait-other': 'waiting',
      'wait-timeout': 'completed',
      done: 'completed',
    });
    expect(calls.noop).to.equal(4);
  });

  it('a signalled wait of an unregistered version does not take the reserved slot of a registered one', async () => {
    await boot();
    await seedInstance('a-unreg', { Workflow: 'eng-noop', Version: 9, Status: 'waiting', WaitingFor: 'go' });
    await seedEvent('a-unreg', 'go');
    await seedInstance('b-reg', { Workflow: 'eng-noop', Status: 'waiting', WaitingFor: 'go', UpdatedAt: T0 + 1 });
    await seedEvent('b-reg', 'go');
    await (await engine()).tick();
    expect([(await instance('a-unreg')).Status, (await instance('b-reg')).Status]).to.deep.equal(['waiting', 'completed']);
  });

  it('leaves an instance alone while another replica holds a valid lease', async () => {
    await boot();
    await seedInstance('held', { Workflow: 'eng-noop', ClaimedBy: 'other', ClaimedUntil: T0 + 10_000, ClaimEpoch: 4 });
    const r1 = await engine();
    await r1.tick();
    expect(pick(await instance('held'), 'Status', 'ClaimedBy')).to.deep.equal({ Status: 'running', ClaimedBy: 'other' });
    clock.set(T0 + 10_001);
    await r1.tick();
    expect(pick(await instance('held'), 'Status', 'ClaimEpoch')).to.deep.equal({ Status: 'completed', ClaimEpoch: 5 });
  });

  it('never activates one instance on two replicas at once', async () => {
    await boot();
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    for (const id of ids) await service.start('eng-sum', { a: 1, b: 1 }, { id });
    const [r1, r2] = [await engine('r1'), await engine('r2')];
    // one activation per replica per tick on SQLite; a round where both race for the same row completes one instance
    for (let round = 0; round < 10; round++) await Promise.all([r1.tick(), r2.tick()]);
    expect(calls.sum).to.equal(10);
    for (const id of ids) expect((await instance(id)).Status).to.equal('completed');
  });

  it('a lost lease aborts the activation; its late writes are discarded', async () => {
    await boot();
    const { id } = await service.start('eng-gated', null);
    const a = await engine('a');
    const b = await engine('b');
    const aTick = a.tick();
    await started.promise;
    await expireLease(id);
    await b.tick();
    gate.resolve('from-a');
    await aTick;
    expect(pick(await instance(id), 'Status', 'Result', 'ClaimEpoch', 'ClaimedBy')).to.deep.equal({ Status: 'completed', Result: 'second', ClaimEpoch: 2, ClaimedBy: null });
    expect((await stepsOf(id)).map((s) => [s.Key, s.Result])).to.deep.equal([['step:work#1', 'second']]);
  });

  it('a self-detected lease expiry without a takeover still releases the row', async () => {
    await boot();
    TestFaults.failure = (p) => (p === 'workflow.lease-renew' ? new Error('database away') : undefined);
    const { id } = await service.start('eng-abortable', null);
    const tick = (await engine()).tick();
    await started.promise;
    // every renewal fails; leaseTtl after the claim the heartbeat reports the lease lost, with no other replica in sight
    await clock.advance(80_000);
    await tick;
    expect(pick(await instance(id), 'Status', 'ClaimedBy', 'ClaimEpoch')).to.deep.equal({ Status: 'running', ClaimedBy: null, ClaimEpoch: 1 });
    expect((await stepsOf(id)).length).to.equal(0);
  });

  it('renews the lease every leaseTtl/3 while a step runs', async () => {
    await boot();
    const { id } = await service.start('eng-gated', null);
    const tick = (await engine()).tick();
    await started.promise;
    expect((await instance(id)).ClaimedUntil).to.equal(T0 + 60_000);
    await clock.advance(20_000);
    await waitFor(async () => (await instance(id)).ClaimedUntil === T0 + 20_000 + 60_000);
    gate.resolve('done');
    await tick;
    expect((await instance(id)).Status).to.equal('completed');
  });

  it('a rejected run fails the instance with Reason error', async () => {
    await boot();
    const { id } = await service.start('eng-boom', null);
    await (await engine()).tick();
    const row = await instance(id);
    expect(pick(row, 'Status', 'Reason', 'FinishedAt', 'ClaimedBy')).to.deep.equal({ Status: 'failed', Reason: 'error', FinishedAt: T0, ClaimedBy: null });
    expect(pick(row.Error!, 'name', 'message')).to.deep.equal({ name: 'RangeError', message: 'boom' });
  });

  it('a journal that does not match the code fails the instance with non-determinism', async () => {
    await boot();
    const { id } = await service.start('eng-sum', { a: 1, b: 1 });
    await seedStep(id, 1, 'step:other#1', { Meta: { after: 0, order: 1 } });
    await (await engine()).tick();
    const row = await instance(id);
    expect(pick(row, 'Status', 'Reason')).to.deep.equal({ Status: 'failed', Reason: 'non-determinism' });
    expect(row.Error?.name).to.equal('NonDeterminismError');
    expect(calls.sum).to.equal(0);
  });

  it('a recorded step the run no longer reaches fails the instance with non-determinism instead of completing it', async () => {
    await boot();
    const { id } = await service.start('eng-sum', { a: 1, b: 1 });
    await seedStep(id, 1, 'step:add#1', { Result: 2, ResultStored: true, Meta: { after: 0, order: 1 } });
    await seedStep(id, 2, 'step:notify#1', { Meta: { after: 1, order: 2 } });
    await (await engine()).tick();
    const row = await instance(id);
    expect(pick(row, 'Status', 'Reason', 'Result')).to.deep.equal({ Status: 'failed', Reason: 'non-determinism', Result: null });
    expect(row.Error?.message).to.contain("'step:notify#1'");
    expect(calls.sum).to.equal(0);
  });

  it('an instance whose version is not registered stays untouched', async () => {
    await boot();
    await seedInstance('v9', { Workflow: 'eng-sum', Version: 9 });
    await (await engine()).tick();
    expect(pick(await instance('v9'), 'Status', 'ClaimEpoch', 'ClaimedBy')).to.deep.equal({ Status: 'running', ClaimEpoch: 0, ClaimedBy: null });
  });

  it('a crash at a fault point records nothing; the next owner runs the step again', async () => {
    await boot();
    TestFaults.crashOnce('workflow.after-step-fn', 'step:add');
    const { id } = await service.start('eng-sum', { a: 4, b: 5 });
    expect(await rejects((await engine('r1')).tick())).to.be.instanceOf(TestCrash);
    expect(pick(await instance(id), 'Status', 'ClaimedBy')).to.deep.equal({ Status: 'running', ClaimedBy: 'r1' });
    expect((await stepsOf(id)).length).to.equal(0);
    clock.set(T0 + 60_001);
    await (await engine('r2')).tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 9 });
    expect(calls.sum).to.equal(2);
  });

  it('a crash thrown by run() itself rejects the tick, writes no failure and keeps the lease', async () => {
    await boot();
    const { id } = await service.start('eng-dead', null);
    expect(await rejects((await engine('r1')).tick())).to.be.instanceOf(TestCrash);
    expect(pick(await instance(id), 'Status', 'Reason', 'Error', 'ClaimedBy')).to.deep.equal({ Status: 'running', Reason: null, Error: null, ClaimedBy: 'r1' });
  });

  it('a crash at the lease renewal stops the heartbeat, discards the late step result and rejects the tick', async () => {
    await boot();
    TestFaults.rule = (p) => p === 'workflow.lease-renew';
    const { id } = await service.start('eng-hb-crash', null);
    const tick = (await engine('r1')).tick().catch((e: unknown) => e);
    await started.promise;
    await clock.advance(20_000);
    await waitFor(() => TestFaults.hits.includes('workflow.lease-renew'));
    gate.resolve('late');
    await clock.advance(40_000);
    expect(await tick).to.be.instanceOf(TestCrash);
    expect(TestFaults.hits.filter((h) => h === 'workflow.lease-renew').length).to.equal(1);
    expect((await stepsOf(id)).length).to.equal(0);
    expect(pick(await instance(id), 'Status', 'ClaimedBy', 'ClaimedUntil')).to.deep.equal({ Status: 'running', ClaimedBy: 'r1', ClaimedUntil: T0 + 60_000 });
  });

  it('CancelRequested ends a parked instance as cancelled without running it', async () => {
    await boot();
    await seedInstance('c', { Workflow: 'eng-noop', CancelRequested: true });
    await (await engine()).tick();
    expect(pick(await instance('c'), 'Status', 'Reason', 'FinishedAt', 'ClaimedBy')).to.deep.equal({ Status: 'cancelled', Reason: 'cancelled', FinishedAt: T0, ClaimedBy: null });
    expect(calls.noop).to.equal(0);
  });

  it('a cancel delivered by the heartbeat aborts the running step', async () => {
    await boot();
    const { id } = await service.start('eng-abortable', null);
    const tick = (await engine()).tick();
    await started.promise;
    await WorkflowInstanceModel.update({ CancelRequested: true }).where('Id', id);
    await clock.advance(20_000);
    await tick;
    expect(pick(await instance(id), 'Status', 'Reason', 'ClaimedBy')).to.deep.equal({ Status: 'cancelled', Reason: 'cancelled', ClaimedBy: null });
    expect((await stepsOf(id)).length).to.equal(0);
  });
});
