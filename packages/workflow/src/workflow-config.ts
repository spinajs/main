import type { RetryPolicyOptions } from '@spinajs/durable';
import { InvalidArgument } from '@spinajs/exceptions';
import { normalizeRetry } from './policy.js';

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
  /** How long one compensation may run before its signal aborts and it is retried; 3 x `leaseTtl` unless set. */
  compensationTimeout: number;
  /** Step retry policy when neither the step nor the `@Workflow` options name one. */
  retry: RetryPolicyOptions;
}

/** `compensationTimeout` is left out: it follows `leaseTtl`. */
export const WORKFLOW_DEFAULTS: Omit<WorkflowConfig, 'compensationTimeout'> = {
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
  const config = { ...WORKFLOW_DEFAULTS, ...r, retry: { ...WORKFLOW_DEFAULTS.retry, ...(r.retry ?? {}) } };
  normalizeRetry(config.retry, 'workflow.retry');
  const compensationTimeout = r.compensationTimeout ?? 3 * config.leaseTtl;
  if (!Number.isInteger(compensationTimeout) || compensationTimeout < 1) throw new InvalidArgument('workflow.compensationTimeout must be an integer >= 1 (ms)');
  return { ...config, compensationTimeout };
}
