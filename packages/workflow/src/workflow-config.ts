import type { RetryPolicyOptions } from '@spinajs/durable';

/** The ORM connection alias of every workflow table; the package config maps it to `default`. */
export const WORKFLOW_CONNECTION = 'workflow';

export interface WorkflowConfig {
  /** Starts the `WorkflowWorker` loop on this replica. */
  enabled: boolean;
  tick: number;
  /** Activations one replica runs at a time. */
  concurrency: number;
  leaseTtl: number;
  shutdownGrace: number;
  maxStepResultBytes: number;
  compensateOnCancel: boolean;
  /** Step retry policy when neither the step nor the `@Workflow` options name one. */
  retry: RetryPolicyOptions;
}

export const WORKFLOW_DEFAULTS: WorkflowConfig = {
  enabled: true,
  tick: 1000,
  concurrency: 10,
  leaseTtl: 60_000,
  shutdownGrace: 30_000,
  maxStepResultBytes: 262_144,
  compensateOnCancel: false,
  retry: { attempts: 3, backoff: 'exponential', delay: '1s', maxDelay: '5m' },
};

export function resolveWorkflowConfig(raw?: Partial<WorkflowConfig> | null): WorkflowConfig {
  const r = raw ?? {};
  return { ...WORKFLOW_DEFAULTS, ...r, retry: { ...WORKFLOW_DEFAULTS.retry, ...(r.retry ?? {}) } };
}
