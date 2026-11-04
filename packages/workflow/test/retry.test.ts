import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { computeBackoff, NonRetryableError } from '@spinajs/durable';
import { normalizeRetry, unitHash, Workflow, WorkflowDefinition, WorkflowService, type WorkflowContext, type WorkflowStepFailed } from '../src/index.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import type { FakeClock } from '@spinajs/durable/testing';
import { instance, pick, stepsOf, T0 } from './support/rows.js';

let attempts: Record<string, number[]> = {};
let caught: string[] = [];

/** Fails attempts 1..failures with `error()`, then returns `ok@<attempt>`. */
function flaky(key: string, failures: number, error: () => Error = () => new Error('transient')) {
  return ({ attempt }: { attempt: number }): string => {
    (attempts[key] ??= []).push(attempt);
    if (attempt <= failures) throw error();
    return `ok@${attempt}`;
  };
}

@Workflow('rt-twice')
export class RtTwice extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('flaky', flaky('twice', 2));
  }
}

@Workflow('rt-exhaust')
export class RtExhaust extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('flaky', flaky('exhaust', 5), { retry: { attempts: 2, backoff: 'fixed', delay: '10s' } });
  }
}

@Workflow('rt-nonretryable')
export class RtNonRetryable extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('flaky', flaky('nonretryable', 5, () => new NonRetryableError('card stolen')), { retry: { attempts: 5 } });
  }
}

@Workflow('rt-retryon')
export class RtRetryOn extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('flaky', flaky('retryon', 5, () => new Error('fatal')), { retry: { attempts: 5, retryOn: (e) => (e as Error).message === 'transient' } });
  }
}

@Workflow('rt-own', { retry: { attempts: 1 } })
export class RtOwn extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('flaky', flaky('own', 1), { retry: { attempts: 2, backoff: 'fixed', delay: '1s' } });
  }
}

@Workflow('rt-workflow-policy', { retry: { attempts: 2, backoff: 'fixed', delay: '7s' } })
export class RtWorkflowPolicy extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('flaky', flaky('workflow-policy', 1));
  }
}

@Workflow('rt-exp', { retry: { attempts: 3, backoff: 'exponential', delay: '10s' } })
export class RtExp extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('flaky', flaky('exp', 1));
  }
}

@Workflow('rt-caught')
export class RtCaught extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    try {
      await ctx.step('final', flaky('final', 9, () => new NonRetryableError('no')));
    } catch (e) {
      caught.push((e as WorkflowStepFailed).errorName);
    }
    return ctx.step('later', flaky('later', 1));
  }
}

@Workflow('rt-swallow')
export class RtSwallow extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    try {
      return await ctx.step('flaky', flaky('swallow', 1));
    } catch {
      return 'swallowed';
    }
  }
}

@Workflow('rt-parallel')
export class RtParallel extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    const [a, b] = await Promise.all([
      ctx.step('slow', flaky('slow', 1), { retry: { attempts: 2, backoff: 'fixed', delay: '30s' } }),
      ctx.step('fast', flaky('fast', 1), { retry: { attempts: 2, backoff: 'fixed', delay: '10s' } }),
    ]);
    return `${a}+${b}`;
  }
}

describe('step retries', () => {
  let service: WorkflowService;
  let clock: FakeClock;

  beforeEach(async () => {
    attempts = {};
    caught = [];
    ({ clock } = await bootTestEnv());
    service = await DI.resolve(WorkflowService);
  });
  after(disposeTestEnv);

  it('a retryable failure parks the instance running until its backoff is over, then runs the next attempt', async () => {
    const { id } = await service.start('rt-twice', null);
    const r1 = await engine();
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WakeAt', 'ClaimedBy')).to.deep.equal({ Status: 'running', WakeAt: T0 + 10_000, ClaimedBy: null });
    const [row] = await stepsOf(id);
    expect(pick(row, 'Status', 'Attempt')).to.deep.equal({ Status: 'retrying', Attempt: 1 });
    expect(row.Error?.message).to.equal('transient');
    clock.set(T0 + 5_000);
    await r1.tick();
    expect(attempts.twice).to.deep.equal([1]);
    clock.set(T0 + 10_000);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WakeAt')).to.deep.equal({ Status: 'running', WakeAt: T0 + 20_000 });
    clock.set(T0 + 20_000);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'ok@3' });
    expect(attempts.twice).to.deep.equal([1, 2, 3]);
    expect(pick((await stepsOf(id))[0], 'Status', 'Attempt')).to.deep.equal({ Status: 'succeeded', Attempt: 3 });
  });

  it('exhausted retries fail the step for good and the run with it', async () => {
    const { id } = await service.start('rt-exhaust', null);
    const r1 = await engine();
    await r1.tick();
    clock.set(T0 + 10_000);
    await r1.tick();
    const row = await instance(id);
    expect(pick(row, 'Status', 'Reason')).to.deep.equal({ Status: 'failed', Reason: 'error' });
    expect(pick(row.Error!, 'name', 'message', 'step')).to.deep.equal({ name: 'Error', message: 'transient', step: 'flaky' });
    expect(pick((await stepsOf(id))[0], 'Status', 'Attempt')).to.deep.equal({ Status: 'failed', Attempt: 2 });
  });

  it('a NonRetryableError fails at once', async () => {
    const { id } = await service.start('rt-nonretryable', null);
    await (await engine()).tick();
    expect(pick(await instance(id), 'Status', 'Reason')).to.deep.equal({ Status: 'failed', Reason: 'error' });
    expect(attempts.nonretryable).to.deep.equal([1]);
  });

  it('retryOn decides which errors retry', async () => {
    const { id } = await service.start('rt-retryon', null);
    await (await engine()).tick();
    expect((await instance(id)).Status).to.equal('failed');
    expect(attempts.retryon).to.deep.equal([1]);
  });

  it("the step's policy wins over the workflow's, which wins over workflow.retry", async () => {
    const own = await service.start('rt-own', null);
    const wf = await service.start('rt-workflow-policy', null);
    const r1 = await engine();
    await r1.tick();
    await r1.tick();
    expect((await instance(own.id)).WakeAt).to.equal(T0 + 1_000);
    expect((await instance(wf.id)).WakeAt).to.equal(T0 + 7_000);
  });

  it('exponential backoff jitter is deterministic per instance, key and attempt', async () => {
    await service.start('rt-exp', null, { id: 'x1' });
    await service.start('rt-exp', null, { id: 'x2' });
    const r1 = await engine();
    await r1.tick();
    await r1.tick();
    const policy = normalizeRetry({ attempts: 3, backoff: 'exponential', delay: '10s' }, 'test');
    for (const id of ['x1', 'x2']) {
      const delay = (await instance(id)).WakeAt! - T0;
      expect(delay).to.equal(computeBackoff(policy, 1, () => unitHash(`${id}:step:flaky#1:1`)));
      expect(delay).to.be.within(9_000, 11_000);
    }
  });

  it('a final failure replays as WorkflowStepFailed, so code that caught it takes the same path', async () => {
    const { id } = await service.start('rt-caught', null);
    const r1 = await engine();
    await r1.tick();
    clock.set(T0 + 10_000);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'ok@2' });
    expect(caught).to.deep.equal(['NonRetryableError', 'NonRetryableError']);
    expect(attempts.final).to.deep.equal([1]);
  });

  it('catching the suspension does not stop the park', async () => {
    const { id } = await service.start('rt-swallow', null);
    const r1 = await engine();
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WakeAt')).to.deep.equal({ Status: 'running', WakeAt: T0 + 10_000 });
    clock.set(T0 + 10_000);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'ok@2' });
  });

  it('parallel retries: the instance wakes for the earliest backoff and each step waits out its own', async () => {
    const { id } = await service.start('rt-parallel', null);
    const r1 = await engine();
    await r1.tick();
    expect((await instance(id)).WakeAt).to.equal(T0 + 10_000);
    expect((await stepsOf(id)).map((s) => [s.Key, s.Status, s.Meta])).to.deep.equal([
      ['step:slow#1', 'retrying', { wakeAt: T0 + 30_000, after: 0 }],
      ['step:fast#1', 'retrying', { wakeAt: T0 + 10_000, after: 0 }],
    ]);
    clock.set(T0 + 10_000);
    await r1.tick();
    // fast ran again; slow parked the instance again until its own backoff is over
    expect(pick(await instance(id), 'Status', 'WakeAt')).to.deep.equal({ Status: 'running', WakeAt: T0 + 30_000 });
    expect(attempts).to.deep.equal({ slow: [1], fast: [1, 2] });
    clock.set(T0 + 30_000);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'ok@2+ok@2' });
    expect(attempts).to.deep.equal({ slow: [1, 2], fast: [1, 2] });
  });
});
