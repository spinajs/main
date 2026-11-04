import { DI } from '@spinajs/di';
import { DbClock, FaultInjector, RowLease } from '@spinajs/durable';
import type { Log } from '@spinajs/log-common';
import {
  ActivationContext,
  InstanceStore,
  Journal,
  resolveWorkflowConfig,
  workflowDriver,
  WorkflowDefinition,
  WorkflowInstanceModel,
  type ActivationInit,
  type RegisteredWorkflow,
} from '../../src/index.js';

const noop = (): void => undefined;
export const quietLog: Log = { child: () => quietLog, trace: noop, debug: noop, info: noop, warn: noop, error: noop, success: noop } as unknown as Log;

export class HarnessWorkflow extends WorkflowDefinition {
  public run(): Promise<void> {
    return Promise.resolve();
  }
}

export const HARNESS_DEFINITION: RegisteredWorkflow = { name: 'harness', version: 1, options: {}, target: HarnessWorkflow, timeoutMs: null };

export interface Harness {
  ctx: ActivationContext;
  abort: AbortController;
  store: InstanceStore;
  release(): Promise<void>;
}

/** Claims `instanceId` as replica `owner` and builds the context an engine would. */
export async function activation(instanceId: string, over: Partial<ActivationInit> = {}, owner = 'r1'): Promise<Harness> {
  const driver = await workflowDriver();
  const store = new InstanceStore(driver, new RowLease(driver), owner);
  const clock = await DI.resolve(DbClock);
  const claim = await store.lease.claim(store.target(instanceId), owner, 60_000, await clock.sync());
  if (!claim) throw new Error(`could not claim ${instanceId}`);
  const abort = new AbortController();
  const ctx = new ActivationContext({
    instance: await WorkflowInstanceModel.where('Id', instanceId).first(),
    definition: HARNESS_DEFINITION,
    journal: await Journal.load(instanceId),
    store,
    epoch: claim.epoch,
    clock,
    faults: await DI.resolve(FaultInjector),
    config: resolveWorkflowConfig({}),
    signal: abort.signal,
    log: quietLog,
    onLeaseLost: () => abort.abort('lease-lost'),
    onCrash: () => abort.abort('crashed'),
    onJournalFailed: () => abort.abort('journal-failed'),
    ...over,
  });
  return {
    ctx,
    abort,
    store,
    release: async () => {
      await ctx.drain();
      await store.release(instanceId, claim.epoch);
    },
  };
}
