import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Workflow, WorkflowDefinition, WorkflowService, WorkflowWorker, type WorkflowContext } from '../src/index.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv, waitFor } from './support/env.js';
import type { FakeClock } from '@spinajs/durable/testing';
import { TestCrash } from './support/faults.js';
import { deferred, instance, pick, stepsOf, T0 } from './support/rows.js';

let started = deferred();
let gate = deferred<string>();
let deadlineAttempts: number[] = [];
let crashRuns = 0;

@Workflow('wk-noop')
export class WkNoop extends WorkflowDefinition<null, string> {
  public run(): Promise<string> {
    return Promise.resolve('done');
  }
}

@Workflow('wk-abortable')
export class WkAbortable extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('work', ({ signal }) => {
      started.resolve();
      return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    });
  }
}

@Workflow('wk-stubborn')
export class WkStubborn extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('work', () => {
      started.resolve();
      return gate.promise;
    });
  }
}

@Workflow('wk-deadline', { timeout: '1h' })
export class WkDeadline extends WorkflowDefinition<null, void> {
  public run(ctx: WorkflowContext<null>): Promise<void> {
    return ctx.step(
      'slow',
      ({ attempt }) => {
        deadlineAttempts.push(attempt);
        throw new Error('not yet');
      },
      { retry: { attempts: 5, backoff: 'fixed', delay: '2h' } },
    );
  }
}

@Workflow('wk-crash')
export class WkCrash extends WorkflowDefinition<null, void> {
  public run(): Promise<void> {
    crashRuns++;
    return Promise.reject(new TestCrash('run'));
  }
}

describe('WorkflowWorker, shutdown and deadlines', () => {
  let service: WorkflowService;
  let clock: FakeClock;

  async function boot(workflow: Record<string, unknown> = {}): Promise<void> {
    ({ clock } = await bootTestEnv({ workflow }));
    service = await DI.resolve(WorkflowService);
  }

  beforeEach(() => {
    started = deferred();
    gate = deferred<string>();
    deadlineAttempts = [];
    crashRuns = 0;
  });
  after(disposeTestEnv);

  it('the worker ticks the engine every workflow.tick', async () => {
    await boot({ enabled: true, tick: 1000 });
    const { id } = await service.start('wk-noop', null);
    await DI.resolve(WorkflowWorker);
    expect(clock.pendingTimers).to.equal(1);
    await clock.advance(1000);
    await waitFor(async () => (await instance(id)).Status === 'completed');
  });

  it('workflow.enabled false starts no loop', async () => {
    await boot({ enabled: false });
    await DI.resolve(WorkflowWorker);
    expect(clock.pendingTimers).to.equal(0);
  });

  it('a crashed tick stops the loop: the dead replica keeps its claim and never ticks again', async () => {
    await boot({ enabled: true, tick: 1000 });
    const { id } = await service.start('wk-crash', null);
    await DI.resolve(WorkflowWorker);
    await clock.advance(1000);
    await waitFor(() => clock.pendingTimers === 0);
    expect(pick(await instance(id), 'Status', 'Error')).to.deep.equal({ Status: 'running', Error: null });
    expect((await instance(id)).ClaimedBy).to.not.equal(null);
    await clock.advance(120_000);
    expect(crashRuns).to.equal(1);
  });

  it('stop() aborts running activations as shutdown, releases their lease and ends the ticks', async () => {
    await boot();
    const { id } = await service.start('wk-abortable', null);
    const r1 = await engine();
    const tick = r1.tick();
    await started.promise;
    await r1.stop();
    await tick;
    expect(pick(await instance(id), 'Status', 'ClaimedBy')).to.deep.equal({ Status: 'running', ClaimedBy: null });
    expect((await stepsOf(id)).length).to.equal(0);
    await r1.tick();
    expect((await instance(id)).Status).to.equal('running');
  });

  it('stop() waits at most workflow.shutdownGrace for an activation that ignores the abort', async () => {
    await boot();
    await service.start('wk-stubborn', null);
    const r1 = await engine();
    const tick = r1.tick();
    await started.promise;
    let stopped = false;
    const stopping = r1.stop().then(() => (stopped = true));
    await clock.advance(2_000);
    await stopping;
    expect(stopped).to.equal(true);
    gate.resolve('late');
    await clock.advance(2_000);
    await tick;
  });

  it('an instance past its timeout fails with Reason timeout; parks never sleep past the deadline', async () => {
    await boot();
    const { id } = await service.start('wk-deadline', null);
    const r1 = await engine();
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WakeAt')).to.deep.equal({ Status: 'running', WakeAt: T0 + 3_600_000 });
    clock.set(T0 + 3_600_000);
    await r1.tick();
    const row = await instance(id);
    expect(pick(row, 'Status', 'Reason')).to.deep.equal({ Status: 'failed', Reason: 'timeout' });
    expect(pick(row.Error!, 'name', 'message')).to.deep.equal({ name: 'WorkflowTimeout', message: "workflow 'wk-deadline' passed its timeout of 3600000 ms" });
    expect(deadlineAttempts).to.deep.equal([1]);
  });
});
