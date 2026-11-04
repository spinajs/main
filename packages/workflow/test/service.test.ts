import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { NonRetryableError } from '@spinajs/durable';
import { InvalidOperation } from '@spinajs/exceptions';
import type { FakeClock } from '@spinajs/durable/testing';
import { Workflow, WorkflowDefinition, WorkflowEngine, WorkflowNotFound, WorkflowService, type WorkflowContext } from '../src/index.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import { instance, pick, rejects, seedInstance, seedStep, stepsOf, T0 } from './support/rows.js';

const fixable = { broken: true, attempts: [] as number[] };

@Workflow('svc-wait')
export class SvcWait extends WorkflowDefinition<null, void> {
  public run(ctx: WorkflowContext<null>): Promise<void> {
    return ctx.step(
      'later',
      () => {
        throw new Error('not yet');
      },
      { retry: { attempts: 5, backoff: 'fixed', delay: '1h' } },
    );
  }
}

@Workflow('svc-cancel-inside')
export class SvcCancelInside extends WorkflowDefinition<null, void> {
  public run(ctx: WorkflowContext<null>): Promise<void> {
    return ctx.step(
      'work',
      async () => {
        await (await DI.resolve(WorkflowService)).cancel(ctx.instanceId, 'from inside');
        throw new Error('not yet');
      },
      { retry: { attempts: 5, backoff: 'fixed', delay: '1h' } },
    );
  }
}

@Workflow('svc-fixable')
export class SvcFixable extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('work', ({ attempt }) => {
      fixable.attempts.push(attempt);
      if (fixable.broken) throw new NonRetryableError('broken');
      return 'fixed';
    });
  }
}

@Workflow('svc-a')
export class SvcA extends WorkflowDefinition<null, string> {
  public run(): Promise<string> {
    return Promise.resolve('a');
  }
}

@Workflow('svc-b')
export class SvcB extends WorkflowDefinition<null, string> {
  public run(): Promise<string> {
    return Promise.resolve('b');
  }
}

/** Its warnings are captured whichever logger the process resolved first. */
class VersionWarningsEngine extends WorkflowEngine {
  public static warnings: string[] = [];
  protected warn(message: string): void {
    VersionWarningsEngine.warnings.push(message);
  }
}

describe('WorkflowService: cancel, retry, list, health', () => {
  let service: WorkflowService;
  let clock: FakeClock;

  beforeEach(async () => {
    fixable.broken = true;
    fixable.attempts = [];
    ({ clock } = await bootTestEnv());
    service = await DI.resolve(WorkflowService);
  });
  after(disposeTestEnv);

  it('cancel() wakes a parked instance at once and the next tick ends it cancelled', async () => {
    const { id } = await service.start('svc-wait', null);
    const r1 = await engine();
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WakeAt')).to.deep.equal({ Status: 'running', WakeAt: T0 + 3_600_000 });
    clock.set(T0 + 5_000);
    await service.cancel(id, 'customer asked');
    expect(pick(await instance(id), 'CancelRequested', 'WakeAt', 'Reason')).to.deep.equal({ CancelRequested: true, WakeAt: T0 + 5_000, Reason: 'customer asked' });
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Reason', 'FinishedAt', 'ClaimedBy')).to.deep.equal({ Status: 'cancelled', Reason: 'customer asked', FinishedAt: T0 + 5_000, ClaimedBy: null });
  });

  it('a cancel that lands while the activation parks still wakes the instance at once', async () => {
    const { id } = await service.start('svc-cancel-inside', null);
    const r1 = await engine();
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'CancelRequested', 'WakeAt')).to.deep.equal({ Status: 'running', CancelRequested: true, WakeAt: T0 });
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Reason')).to.deep.equal({ Status: 'cancelled', Reason: 'from inside' });
  });

  it('cancel() leaves a terminal instance alone and refuses an unknown id', async () => {
    await seedInstance('done', { Workflow: 'svc-a', Status: 'completed' });
    await service.cancel('done');
    expect(pick(await instance('done'), 'Status', 'CancelRequested')).to.deep.equal({ Status: 'completed', CancelRequested: false });
    expect(await rejects(service.cancel('nope'))).to.be.instanceOf(WorkflowNotFound);
  });

  it('cancel() keeps a reason within the column without splitting a character', async () => {
    await seedInstance('long', { Workflow: 'svc-a' });
    await service.cancel('long', `${'x'.repeat(63)}😀tail`);
    expect((await instance('long')).Reason).to.equal(`${'x'.repeat(63)}😀`);
  });

  it('retry() runs a failed instance again from its failed step, with a fresh attempt budget', async () => {
    const { id } = await service.start('svc-fixable', null);
    const r1 = await engine();
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Reason')).to.deep.equal({ Status: 'failed', Reason: 'error' });
    fixable.broken = false;
    await service.retry(id);
    expect(pick(await instance(id), 'Status', 'Reason', 'Error', 'FinishedAt')).to.deep.equal({ Status: 'running', Reason: null, Error: null, FinishedAt: null });
    // Meta.after stays: without it the whole journal would drop to the lenient replay check
    expect(pick((await stepsOf(id))[0], 'Status', 'Attempt', 'Meta')).to.deep.equal({ Status: 'retrying', Attempt: 0, Meta: { after: 0 } });
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'fixed' });
    expect(fixable.attempts).to.deep.equal([1, 1]);
  });

  it('retry() resets only failed step and emit rows and drops their stale backoff', async () => {
    await seedInstance('f1', { Workflow: 'svc-a', Status: 'failed', Reason: 'error' });
    await seedStep('f1', 1, 'step:ok#1', { Meta: { after: 0, order: 1 } });
    await seedStep('f1', 2, 'step:bad#1', { Status: 'failed', Attempt: 3, Meta: { after: 1, order: 2, wakeAt: T0 } });
    await seedStep('f1', 3, 'emit:sent#1', { Status: 'failed', Attempt: 2, Meta: null });
    await seedStep('f1', 4, 'marker:now#1', { Status: 'failed', Meta: { after: 1 } });
    await service.retry('f1');
    const rows = (await stepsOf('f1')).map((s) => pick(s, 'Key', 'Status', 'Attempt', 'Meta'));
    expect(rows).to.deep.equal([
      { Key: 'step:ok#1', Status: 'succeeded', Attempt: 1, Meta: { after: 0, order: 1 } },
      { Key: 'step:bad#1', Status: 'retrying', Attempt: 0, Meta: { after: 1 } },
      { Key: 'emit:sent#1', Status: 'retrying', Attempt: 0, Meta: null },
      { Key: 'marker:now#1', Status: 'failed', Attempt: 1, Meta: { after: 1 } },
    ]);
  });

  it('retry() refuses an instance that has not failed', async () => {
    const { id } = await service.start('svc-a', null);
    const err = await rejects(service.retry(id));
    expect(err).to.be.instanceOf(InvalidOperation);
    expect(err.message).to.equal(`workflow instance '${id}' is running; only a failed instance can be retried`);
    expect(await rejects(service.retry('nope'))).to.be.instanceOf(WorkflowNotFound);
  });

  it('list() filters by workflow and status and pages by id', async () => {
    for (const id of ['l1', 'l2', 'l3']) await service.start('svc-a', null, { id });
    await service.start('svc-b', null, { id: 'l0' });
    await seedInstance('l4', { Workflow: 'svc-a', Status: 'failed' });
    const ids = async (filter: Parameters<WorkflowService['list']>[0]) => (await service.list(filter)).map((v) => v.id);
    expect(await ids({ workflow: 'svc-a' })).to.deep.equal(['l1', 'l2', 'l3', 'l4']);
    expect(await ids({ workflow: 'svc-a', status: ['failed'] })).to.deep.equal(['l4']);
    expect(await ids({ limit: 2 })).to.deep.equal(['l0', 'l1']);
    expect(await ids({ limit: 2, after: 'l1' })).to.deep.equal(['l2', 'l3']);
    expect((await service.list({ workflow: 'svc-b' }))[0]).to.deep.include({ id: 'l0', workflow: 'svc-b', status: 'running' });
  });

  it('health() lists the unfinished instances of versions no class provides', async () => {
    await seedInstance('a1', { Workflow: 'svc-a', Version: 1 });
    await seedInstance('a7-1', { Workflow: 'svc-a', Version: 7 });
    await seedInstance('a7-2', { Workflow: 'svc-a', Version: 7, Status: 'sleeping' });
    await seedInstance('gone', { Workflow: 'svc-gone', Version: 1, Status: 'waiting' });
    await seedInstance('old', { Workflow: 'svc-gone', Version: 2, Status: 'completed' });
    expect(await service.health()).to.deep.equal({
      missingVersions: [
        { workflow: 'svc-a', version: 7, instances: 2 },
        { workflow: 'svc-gone', version: 1, instances: 1 },
      ],
    });
  });

  it('the engine warns about missing versions on every tick', async () => {
    // concurrency 1: no clamp warning on SQLite, so only the version warnings are captured
    await bootTestEnv({ workflow: { concurrency: 1 } });
    VersionWarningsEngine.warnings = [];
    await seedInstance('gone', { Workflow: 'svc-gone', Version: 1 });
    const r1 = await DI.resolve(VersionWarningsEngine, [{ replicaId: 'r1' }]);
    await r1.tick();
    await r1.tick();
    expect(VersionWarningsEngine.warnings).to.deep.equal(Array(2).fill("workflow 'svc-gone' version 1 is not registered; 1 unfinished instance(s) stay untouched"));
  });
});
