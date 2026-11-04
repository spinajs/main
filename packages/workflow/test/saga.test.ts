import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { NonRetryableError } from '@spinajs/durable';
import { Workflow, WorkflowDefinition, WorkflowService, type WorkflowContext, type WorkflowEngine } from '../src/index.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv, waitFor } from './support/env.js';
import type { FakeClock } from '@spinajs/durable/testing';
import { TestCrash } from './support/faults.js';
import { deferred, instance, pick, rejects, stepsOf, T0 } from './support/rows.js';

let effects: string[] = [];
const flags = { crashedOnce: false, bankDown: true };
let refundStarted = deferred();
let refundGate = deferred();

const noCourier = (): never => {
  throw new NonRetryableError('no courier');
};

/** A step body that records `effect` and returns `value`. */
const record = (effect: string, value: string) => (): string => {
  effects.push(effect);
  return value;
};

/** A compensation that records `<prefix>:<step result>`. */
const undo =
  (prefix: string) =>
  async (id: string): Promise<void> => {
    effects.push(`${prefix}:${id}`);
  };

@Workflow('saga-order')
export class SagaOrder extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    await ctx.step('charge', record('charge', 'ch-1'), { compensate: undo('refund') });
    await ctx.step('reserve', record('reserve', 'rs-1'), { compensate: undo('release') });
    await ctx.step('ship', noCourier);
    return 'shipped';
  }
}

@Workflow('saga-crash')
export class SagaCrash extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    await ctx.step('charge', record('charge', 'ch-1'), {
      compensate: async (id) => {
        if (!flags.crashedOnce) {
          flags.crashedOnce = true;
          effects.push('refund-crash');
          throw new TestCrash('refund');
        }
        effects.push(`refund:${id}`);
      },
    });
    await ctx.step('reserve', record('reserve', 'rs-1'), { compensate: undo('release') });
    await ctx.step('ship', noCourier);
    return 'shipped';
  }
}

@Workflow('saga-stuck')
export class SagaStuck extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    await ctx.step('charge', record('charge', 'ch-1'), {
      retry: { attempts: 2, backoff: 'fixed', delay: '5s' },
      compensate: async () => {
        effects.push('refund-try');
        if (flags.bankDown) throw new Error('bank down');
        effects.push('refunded');
      },
    });
    await ctx.step('ship', noCourier);
    return 'shipped';
  }
}

@Workflow('saga-cancel')
export class SagaCancel extends WorkflowDefinition<null, void> {
  public async run(ctx: WorkflowContext<null>): Promise<void> {
    await ctx.step('charge', record('charge', 'ch-1'), { compensate: undo('refund') });
    await ctx.step(
      'wait',
      () => {
        throw new Error('later');
      },
      { retry: { attempts: 5, backoff: 'fixed', delay: '1h' } },
    );
  }
}

@Workflow('saga-fail')
export class SagaFail extends WorkflowDefinition<null, never> {
  public async run(ctx: WorkflowContext<null>): Promise<never> {
    await ctx.step('charge', record('charge', 'ch-1'), { compensate: undo('refund') });
    return ctx.fail('out of stock');
  }
}

/** The refund blocks on `refundGate`, so a test can hold the compensation pass open past leaseTtl. */
@Workflow('saga-slow-refund')
export class SagaSlowRefund extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    await ctx.step('charge', record('charge', 'ch-1'), {
      compensate: async () => {
        effects.push('refund-start');
        refundStarted.resolve();
        await refundGate.promise;
        effects.push('refund-end');
      },
    });
    await ctx.step('ship', noCourier);
    return 'shipped';
  }
}

@Workflow('saga-narrow')
export class SagaNarrow extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    await ctx.step('charge', record('charge', 'ch-1'), {
      compensate: async (_id, cctx) => {
        effects.push(`narrow:${cctx.instanceId}:${'step' in cctx}:${'emit' in cctx}:${'now' in cctx}`);
      },
    });
    await ctx.step('ship', noCourier);
    return 'shipped';
  }
}

/** Branch `a` took two steps while branch `b` was still sleeping when the cancel landed. */
@Workflow('saga-branches')
export class SagaBranches extends WorkflowDefinition<null, void> {
  public async run(ctx: WorkflowContext<null>): Promise<void> {
    const a = async (): Promise<void> => {
      await ctx.step('a1', record('a1', 'A1'), { compensate: undo('undo') });
      await ctx.step('a2', record('a2', 'A2'), { compensate: undo('undo') });
    };
    const b = async (): Promise<void> => {
      await ctx.sleep('1h');
      await ctx.step('b1', record('b1', 'B1'), { compensate: undo('undo') });
    };
    await Promise.all([a(), b()]);
  }
}

@Workflow('saga-escape')
export class SagaEscape extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    await ctx.step('charge', record('charge', 'ch-1'), {
      compensate: async () => {
        try {
          await ctx.step('inner', record('inner', 'x'));
        } catch (err) {
          effects.push(`refused:${(err as Error).name}`);
        }
      },
    });
    await ctx.step('ship', noCourier);
    return 'shipped';
  }
}

describe('saga compensation (D6)', () => {
  let service: WorkflowService;
  let clock: FakeClock;
  let r1: WorkflowEngine;

  async function boot(workflow: Record<string, unknown> = {}): Promise<void> {
    ({ clock } = await bootTestEnv({ workflow }));
    service = await DI.resolve(WorkflowService);
    r1 = await engine();
  }

  beforeEach(async () => {
    effects = [];
    flags.crashedOnce = false;
    flags.bankDown = true;
    refundStarted = deferred();
    refundGate = deferred();
    await boot();
  });
  after(disposeTestEnv);

  it('a three-step saga failing at step 3 compensates step 2, then step 1', async () => {
    const { id } = await service.start('saga-order', null);
    await r1.tick();
    expect(effects).to.deep.equal(['charge', 'reserve', 'release:rs-1', 'refund:ch-1']);
    const row = await instance(id);
    expect(pick(row, 'Status', 'Reason', 'FinishedAt', 'ClaimedBy')).to.deep.equal({ Status: 'compensated', Reason: 'error', FinishedAt: T0, ClaimedBy: null });
    expect(pick(row.Error!, 'name', 'message', 'step')).to.deep.equal({ name: 'NonRetryableError', message: 'no courier', step: 'ship' });
    const steps = await stepsOf(id);
    expect(steps.map((s) => [s.Key, s.Seq, s.Status])).to.deep.equal([
      ['step:charge#1', 1, 'succeeded'],
      ['step:reserve#1', 2, 'succeeded'],
      ['step:ship#1', 3, 'failed'],
      ['compensate:reserve#1', 1_000_000, 'succeeded'],
      ['compensate:charge#1', 1_000_001, 'succeeded'],
    ]);
    expect(steps[0].Meta).to.include({ compensate: true });
    expect(steps.slice(3).every((s) => typeof s.Meta?.after === 'number')).to.equal(true);
  });

  it('a crash in the middle of compensation resumes at the remaining compensation', async () => {
    const { id } = await service.start('saga-crash', null);
    expect(await rejects((await engine('r1')).tick())).to.be.instanceOf(TestCrash);
    expect(pick(await instance(id), 'Status', 'ClaimedBy')).to.deep.equal({ Status: 'compensating', ClaimedBy: 'r1' });
    expect((await stepsOf(id)).filter((s) => s.Kind === 'compensate').map((s) => s.Key)).to.deep.equal(['compensate:reserve#1']);
    clock.set(T0 + 60_001);
    await (await engine('r2')).tick();
    expect((await instance(id)).Status).to.equal('compensated');
    expect(effects).to.deep.equal(['charge', 'reserve', 'release:rs-1', 'refund-crash', 'refund:ch-1']);
  });

  it('a compensation longer than leaseTtl keeps the lease; a second replica does not run it again', async () => {
    const { id } = await service.start('saga-slow-refund', null);
    const tick = r1.tick();
    await refundStarted.promise;
    expect(pick(await instance(id), 'Status', 'ClaimedBy')).to.deep.equal({ Status: 'compensating', ClaimedBy: 'r1' });
    // the pass runs under the heartbeat: three renewals carry the lease past the original TTL. Each renewal is real
    // I/O (an UPDATE, then a read of CancelRequested), so the fake clock moves one period at a time, after the beat.
    for (const at of [20_000, 40_000, 60_000]) {
      await clock.advance(20_000);
      await waitFor(async () => (await instance(id)).ClaimedUntil === T0 + at + 60_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await clock.advance(10_000);
    await (await engine('r2')).tick();
    expect(effects.filter((e) => e === 'refund-start')).to.have.length(1);
    refundGate.resolve();
    await tick;
    expect(pick(await instance(id), 'Status', 'ClaimedBy')).to.deep.equal({ Status: 'compensated', ClaimedBy: null });
    expect(effects).to.deep.equal(['charge', 'refund-start', 'refund-end']);
  });

  it('a compensation receives a narrowed context: no durable operations inside it', async () => {
    const { id } = await service.start('saga-narrow', null);
    await r1.tick();
    expect((await instance(id)).Status).to.equal('compensated');
    expect(effects).to.deep.equal(['charge', `narrow:${id}:false:false:false`]);
  });

  it('a compensation that reaches for the outer ctx cannot journal a step', async () => {
    const { id } = await service.start('saga-escape', null);
    await r1.tick();
    expect((await instance(id)).Status).to.equal('compensated');
    expect(effects).to.deep.equal(['charge', 'refused:WorkflowNestingError']);
    expect((await stepsOf(id)).map((s) => s.Key)).to.not.include('step:inner#1');
  });

  it('a compensation that exhausts its retries fails the instance with compensation-failed', async () => {
    const { id } = await service.start('saga-stuck', null);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WakeAt')).to.deep.equal({ Status: 'compensating', WakeAt: T0 + 5_000 });
    clock.set(T0 + 5_000);
    await r1.tick();
    const row = await instance(id);
    expect(pick(row, 'Status', 'Reason')).to.deep.equal({ Status: 'failed', Reason: 'compensation-failed' });
    expect(pick(row.Error!, 'name', 'message', 'step')).to.deep.equal({ name: 'Error', message: 'bank down', step: 'charge' });
    expect((row.Error!.details as { original: { message: string } }).original.message).to.equal('no courier');
    expect(effects).to.deep.equal(['charge', 'refund-try', 'refund-try']);
  });

  it('retry() of a compensation-failed instance runs the failed compensation again and keeps the original failure', async () => {
    const { id } = await service.start('saga-stuck', null);
    await r1.tick();
    clock.set(T0 + 5_000);
    await r1.tick();
    flags.bankDown = false;
    await service.retry(id);
    // only the compensation row is reset; the step that failed for good, and the failure it stands for, stay
    const retried = await instance(id);
    expect(pick(retried, 'Status', 'Reason')).to.deep.equal({ Status: 'compensating', Reason: 'error' });
    expect(pick(retried.Error!, 'name', 'message', 'step')).to.deep.equal({ name: 'NonRetryableError', message: 'no courier', step: 'ship' });
    expect((await stepsOf(id)).map((s) => [s.Key, s.Status, s.Attempt])).to.deep.equal([
      ['step:charge#1', 'succeeded', 1],
      ['step:ship#1', 'failed', 1],
      ['compensate:charge#1', 'retrying', 0],
    ]);
    await r1.tick();
    const done = await instance(id);
    expect(pick(done, 'Status', 'Reason')).to.deep.equal({ Status: 'compensated', Reason: 'error' });
    expect(done.Error?.message).to.equal('no courier');
    expect(effects.slice(-2)).to.deep.equal(['refund-try', 'refunded']);
  });

  it('cancel() skips compensations by default', async () => {
    const { id } = await service.start('saga-cancel', null);
    await r1.tick();
    await service.cancel(id);
    await r1.tick();
    expect((await instance(id)).Status).to.equal('cancelled');
    expect(effects).to.deep.equal(['charge']);
  });

  it('with workflow.compensateOnCancel a cancel compensates and ends cancelled', async () => {
    await boot({ compensateOnCancel: true });
    const { id } = await service.start('saga-cancel', null);
    await r1.tick();
    await service.cancel(id, 'customer asked');
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Reason')).to.deep.equal({ Status: 'cancelled', Reason: 'customer asked' });
    expect(effects).to.deep.equal(['charge', 'refund:ch-1']);
    expect((await stepsOf(id)).filter((s) => s.Kind === 'compensate').map((s) => s.Key)).to.deep.equal(['compensate:charge#1']);
  });

  it('a cancelled fan-out compensates every step a branch took, newest first, while another branch still sleeps', async () => {
    await boot({ compensateOnCancel: true });
    const { id } = await service.start('saga-branches', null);
    await r1.tick();
    expect((await instance(id)).Status).to.equal('sleeping');
    await service.cancel(id);
    await r1.tick();
    expect((await instance(id)).Status).to.equal('cancelled');
    expect(effects).to.deep.equal(['a1', 'a2', 'undo:A2', 'undo:A1']);
  });

  it('ctx.fail() compensates too', async () => {
    const { id } = await service.start('saga-fail', null);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Reason')).to.deep.equal({ Status: 'compensated', Reason: 'fail' });
    expect(effects).to.deep.equal(['charge', 'refund:ch-1']);
  });
});
