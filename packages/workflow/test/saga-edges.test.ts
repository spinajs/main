import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { NonRetryableError } from '@spinajs/durable';
import type { FakeClock } from '@spinajs/durable/testing';
import { Workflow, WorkflowDefinition, WorkflowService, type CompensationContext, type WorkflowContext, type WorkflowEngine } from '../src/index.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv, waitFor } from './support/env.js';
import { TestCrash } from './support/faults.js';
import { deferred, instance, pick, rejects, seedInstance, seedStep, stepsOf, T0 } from './support/rows.js';

let effects: string[] = [];
let aGate = deferred();
let bGate = deferred();
const flags = { bankDown: true, crashed: false };
let cancelInside: (() => Promise<void>) | undefined;

const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const undo =
  (prefix: string) =>
  async (v: string): Promise<void> => {
    effects.push(`${prefix}:${v}`);
  };
const noCourier = (): never => {
  throw new NonRetryableError('no courier');
};

/** Step `b` ignores the deadline's abort and commits while the engine waits to start the pass. */
@Workflow('edge-late', { timeout: '30s' })
export class EdgeLate extends WorkflowDefinition<null, void> {
  public async run(ctx: WorkflowContext<null>): Promise<void> {
    const a = ctx.step('a', () => 'A', {
      compensate: async (v) => {
        effects.push(`undo:${v}`);
        await aGate.promise;
      },
    });
    const b = ctx.step(
      'b',
      async () => {
        await bGate.promise;
        effects.push('b');
        return 'B';
      },
      { compensate: undo('undo') },
    );
    await Promise.all([a, b]);
  }
}

/** Branch b awaits something outside the workflow between its two steps, while `long` still runs. */
@Workflow('edge-nondurable')
export class EdgeNonDurable extends WorkflowDefinition<null, void> {
  public async run(ctx: WorkflowContext<null>): Promise<void> {
    const long = ctx.step('long', ({ signal }) => new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const b = (async (): Promise<void> => {
      await ctx.step('b1', () => 'B1', { compensate: undo('undo') });
      await realDelay(50);
      await ctx.step('b2', () => 'B2', { compensate: undo('undo') });
    })();
    await Promise.all([long, b]);
  }
}

/** The code now ships first; journals seeded with `pack` at position 1 no longer match it. */
@Workflow('edge-moved', { timeout: '1h' })
export class EdgeMoved extends WorkflowDefinition<null, void> {
  public async run(ctx: WorkflowContext<null>): Promise<void> {
    await ctx.step('ship', () => 'sh-1');
    await ctx.step('charge', () => 'ch-1', { compensate: undo('refund') });
  }
}

/** After its compensated step, run() awaits something that never settles; the deadline ends the live run. */
@Workflow('edge-hang', { timeout: '30s' })
export class EdgeHang extends WorkflowDefinition<null, void> {
  public async run(ctx: WorkflowContext<null>): Promise<void> {
    await ctx.step('charge', () => 'ch-1', {
      retry: { attempts: 3, backoff: 'fixed', delay: '5s' },
      compensate: async () => {
        effects.push('refund-try');
        if (flags.bankDown) throw new Error('bank down');
        effects.push('refunded');
      },
    });
    await new Promise(() => undefined);
  }
}

/** A cancel lands while a step runs, then the run fails, then the pass crashes. */
@Workflow('edge-cancel-race')
export class EdgeCancelRace extends WorkflowDefinition<null, void> {
  public async run(ctx: WorkflowContext<null>): Promise<void> {
    await ctx.step('charge', () => 'ch-1', {
      compensate: async (v) => {
        if (!flags.crashed) {
          flags.crashed = true;
          throw new TestCrash('refund');
        }
        effects.push(`refund:${v}`);
      },
    });
    await ctx.step('cancel-me', async () => {
      await cancelInside?.();
      return 1;
    });
    await ctx.step('ship', noCourier);
  }
}

/** Its marker comes first; a journal that lost the marker row stops the replay before `charge`. */
@Workflow('edge-marker')
export class EdgeMarker extends WorkflowDefinition<null, void> {
  public async run(ctx: WorkflowContext<null>): Promise<void> {
    ctx.uuid();
    await ctx.step('charge', () => 'ch-1', { compensate: undo('refund') });
    await ctx.step('ship', noCourier);
  }
}

/** The refund ignores everything but its own signal, and then not even that. */
@Workflow('edge-stuck-refund')
export class EdgeStuckRefund extends WorkflowDefinition<null, void> {
  public async run(ctx: WorkflowContext<null>): Promise<void> {
    await ctx.step('charge', () => 'ch-1', {
      retry: { attempts: 3, backoff: 'fixed', delay: '5s' },
      compensate: async (_v, cctx: CompensationContext) => {
        effects.push('refund-start');
        await new Promise((resolve) => cctx.signal.addEventListener('abort', resolve));
        effects.push(`aborted:${(cctx.signal.reason as Error).name}`);
        await new Promise(() => undefined);
      },
    });
    await ctx.step('ship', noCourier);
  }
}

describe('saga compensation: incomplete collections, bounds and late steps', () => {
  let service: WorkflowService;
  let clock: FakeClock;
  let r1: WorkflowEngine;

  async function boot(workflow: Record<string, unknown> = {}): Promise<void> {
    ({ clock } = await bootTestEnv({ workflow }));
    service = await DI.resolve(WorkflowService);
    r1 = await engine();
  }

  /** Each renewal and each wait is real I/O, so the fake clock moves in small steps with real pauses between them. */
  async function advanceTo(at: number): Promise<void> {
    while (clock.now() < T0 + at) {
      await realDelay(30);
      await clock.advance(Math.min(1_000, T0 + at - clock.now()));
    }
  }

  async function seedMoved(id: string, over: Record<string, unknown> = {}): Promise<void> {
    await seedInstance(id, { Workflow: 'edge-moved', ...over });
    await seedStep(id, 1, 'step:pack#1', { Meta: { after: 0, order: 1 } });
    await seedStep(id, 2, 'step:charge#1', { Result: 'ch-1', ResultStored: true, Meta: { compensate: true, after: 1, order: 2 } });
  }

  beforeEach(async () => {
    effects = [];
    aGate = deferred();
    bGate = deferred();
    flags.bankDown = true;
    flags.crashed = false;
    cancelInside = undefined;
    await boot();
  });
  after(disposeTestEnv);

  it('a step that commits after the deadline aborted the run is drained into the pass and compensated first', async () => {
    const { id } = await service.start('edge-late', null);
    const tick = r1.tick();
    await waitFor(async () => (await stepsOf(id)).some((s) => s.Key === 'step:a#1'));
    await advanceTo(20_000);
    await waitFor(async () => (await instance(id)).ClaimedUntil === T0 + 80_000);
    // the deadline at 30s, then the grace of the run and of its drain: the engine now waits for `b`
    await advanceTo(36_000);
    expect(effects).to.deep.equal([]);
    bGate.resolve();
    await waitFor(() => effects.includes('undo:A'));
    aGate.resolve();
    await tick;
    expect(effects).to.deep.equal(['b', 'undo:B', 'undo:A']);
    expect(pick(await instance(id), 'Status', 'Reason')).to.deep.equal({ Status: 'compensated', Reason: 'timeout' });
  });

  it('a collecting replay goes on past a non-durable await until every compensable step registered', async () => {
    await boot({ compensateOnCancel: true });
    const { id } = await service.start('edge-nondurable', null);
    const tick = r1.tick();
    await waitFor(async () => (await stepsOf(id)).some((s) => s.Key === 'step:b2#1'));
    await r1.stop();
    await tick;
    await service.cancel(id);
    await (await engine('r2')).tick();
    expect(effects).to.deep.equal(['undo:B2', 'undo:B1']);
    expect((await instance(id)).Status).to.equal('cancelled');
  });

  it('a timeout found at claim whose replay no longer matches the journal fails with compensation-failed', async () => {
    await seedMoved('t3');
    clock.set(T0 + 3_600_000);
    await r1.tick();
    const row = await instance('t3');
    expect(pick(row, 'Status', 'Reason')).to.deep.equal({ Status: 'failed', Reason: 'compensation-failed' });
    expect(row.Error?.name).to.equal('NonDeterminismError');
    expect((row.Error?.details as { originalReason: string }).originalReason).to.equal('timeout');
    expect(effects).to.deep.equal([]);
  });

  it('a cancel found at claim whose replay no longer matches the journal keeps the cancel through retry()', async () => {
    await boot({ compensateOnCancel: true });
    await seedMoved('t4', { Status: 'sleeping', WakeAt: T0, CancelRequested: true, Reason: 'customer' });
    await r1.tick();
    const row = await instance('t4');
    expect(pick(row, 'Status', 'Reason')).to.deep.equal({ Status: 'failed', Reason: 'compensation-failed' });
    expect((row.Error?.details as { originalReason: string }).originalReason).to.equal('customer');
    await service.retry('t4');
    expect(pick(await instance('t4'), 'Status', 'Reason', 'CancelRequested')).to.deep.equal({ Status: 'compensating', Reason: 'customer', CancelRequested: true });
    expect(effects).to.deep.equal([]);
  });

  it('a resumed pass whose replay no longer matches the journal fails with compensation-failed', async () => {
    await seedMoved('t6', { Status: 'compensating', Reason: 'error', Error: { name: 'Error', message: 'boom' } });
    await r1.tick();
    const row = await instance('t6');
    expect(pick(row, 'Status', 'Reason')).to.deep.equal({ Status: 'failed', Reason: 'compensation-failed' });
    expect((row.Error?.details as { original: { message: string } }).original.message).to.equal('boom');
    expect(effects).to.deep.equal([]);
  });

  it('the compensating row stores the decision: a cancel that lands mid-run does not turn a failure into a cancel', async () => {
    cancelInside = () => service.cancel('t5', 'customer');
    await service.start('edge-cancel-race', null, { id: 't5' });
    expect(await rejects(r1.tick())).to.be.instanceOf(TestCrash);
    expect(pick(await instance('t5'), 'Status', 'Reason', 'CancelRequested')).to.deep.equal({ Status: 'compensating', Reason: 'error', CancelRequested: false });
    clock.set(T0 + 60_001);
    await (await engine('r2')).tick();
    expect(pick(await instance('t5'), 'Status', 'Reason')).to.deep.equal({ Status: 'compensated', Reason: 'error' });
    expect(effects).to.deep.equal(['refund:ch-1']);
  });

  it('a resumed pass ends its replay once every compensable step registered, though run() never settles', async () => {
    const { id } = await service.start('edge-hang', null);
    const tick = r1.tick();
    await waitFor(async () => (await stepsOf(id)).some((s) => s.Key === 'step:charge#1'));
    await advanceTo(20_000);
    await waitFor(async () => (await instance(id)).ClaimedUntil === T0 + 80_000);
    await advanceTo(36_000);
    await tick;
    const parked = await instance(id);
    expect(pick(parked, 'Status', 'Reason', 'ClaimedBy')).to.deep.equal({ Status: 'compensating', Reason: 'timeout', ClaimedBy: null });
    flags.bankDown = false;
    clock.set(parked.WakeAt!);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Reason')).to.deep.equal({ Status: 'compensated', Reason: 'timeout' });
    expect(effects).to.deep.equal(['refund-try', 'refund-try', 'refunded']);
  });

  it('a pass whose replay cannot reach a compensable step refuses to compensate the rest', async () => {
    await seedInstance('t7', { Workflow: 'edge-marker', Status: 'compensating', Reason: 'error', Error: { name: 'NonRetryableError', message: 'no courier', step: 'ship' } });
    await seedStep('t7', 2, 'step:charge#1', { Result: 'ch-1', ResultStored: true, Meta: { compensate: true, after: 0, order: 1 } });
    await seedStep('t7', 3, 'step:ship#1', { Status: 'failed', Error: { name: 'NonRetryableError', message: 'no courier' }, Meta: { after: 1, order: 2 } });
    await r1.tick();
    const row = await instance('t7');
    expect(pick(row, 'Status', 'Reason')).to.deep.equal({ Status: 'failed', Reason: 'compensation-failed' });
    expect(pick(row.Error!, 'name')).to.deep.equal({ name: 'WorkflowCompensationIncomplete' });
    expect(row.Error?.message).to.contain('step:charge#1');
    expect(effects).to.deep.equal([]);
  });

  it('a compensation past workflow.compensationTimeout is aborted, journaled retrying and the lease released', async () => {
    await boot({ compensationTimeout: 30_000 });
    const { id } = await service.start('edge-stuck-refund', null);
    const tick = r1.tick();
    await waitFor(() => effects.includes('refund-start'));
    await advanceTo(20_000);
    await waitFor(async () => (await instance(id)).ClaimedUntil === T0 + 80_000);
    await advanceTo(30_000);
    await tick;
    expect(pick(await instance(id), 'Status', 'WakeAt', 'ClaimedBy')).to.deep.equal({ Status: 'compensating', WakeAt: T0 + 35_000, ClaimedBy: null });
    const row = (await stepsOf(id)).find((s) => s.Key === 'compensate:charge#1')!;
    expect(pick(row, 'Status', 'Attempt')).to.deep.equal({ Status: 'retrying', Attempt: 1 });
    expect(row.Error?.name).to.equal('WorkflowCompensationTimeout');
    expect(effects).to.deep.equal(['refund-start', 'aborted:WorkflowCompensationTimeout']);
  });
});
