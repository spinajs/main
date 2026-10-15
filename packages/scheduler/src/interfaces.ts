import type { Constructor } from '@spinajs/di';
import type { QueueJob } from '@spinajs/queue';
import type { ScheduleSpec } from './time/spec.js';
import type { ScheduledTask } from './ScheduledTask.js';

export type Duration = number | string;
export type MisfireOption = 'skip' | 'run-once' | `catch-up(${number})`;

export interface RetryPolicyOptions {
  /** Total attempts including the first one. */
  attempts: number;
  backoff?: 'fixed' | 'exponential';
  delay?: Duration;
  maxDelay?: Duration;
  retryOn?: (err: unknown) => boolean;
}

export interface ScheduleOptions {
  cron?: string;
  every?: Duration;
  at?: string;
  manual?: boolean;
  timezone?: string;
  jitter?: Duration;
  misfire?: MisfireOption;
  misfireThreshold?: Duration;
  overlap?: 'skip' | 'queue';
  runOn?: 'leader' | 'all';
  emit?: Constructor<QueueJob>;
  /** JSON Schema for parameters of manual runs. */
  params?: object;
  retry?: RetryPolicyOptions;
  resumable?: boolean;
  timeout?: Duration;
  pauseAfterFailures?: number;
  enabled?: boolean;
}

export interface ConfigScheduleEntry extends Omit<ScheduleOptions, 'emit' | 'retry'> {
  name: string;
  /** Class name of a @Schedule class, or the name of a @Task method (R13, Task 33b). */
  task?: string;
  retry?: Omit<RetryPolicyOptions, 'retryOn'>;
}

export interface NormalizedRetry {
  attempts: number;
  backoff: 'fixed' | 'exponential';
  delayMs: number;
  maxDelayMs: number;
  retryOn?: (err: unknown) => boolean;
}

export type MisfirePolicy = { kind: 'skip' } | { kind: 'run-once' } | { kind: 'catch-up'; max: number };

export interface ScheduleDefinition {
  name: string;
  spec: ScheduleSpec;
  jitterMs: number;
  misfire: MisfirePolicy;
  misfireThresholdMs: number;
  overlap: 'skip' | 'queue';
  runOn: 'leader' | 'all';
  emit?: Constructor<QueueJob>;
  paramsSchema?: object;
  retry?: NormalizedRetry;
  resumable: boolean;
  timeoutMs?: number;
  pauseAfterFailures?: number;
  enabled: boolean;
  task: Constructor<ScheduledTask>;
  source: 'decorator' | 'config' | 'builtin';
}

export interface SchedulerConfig {
  enabled: boolean;
  tick: number;
  leaseTtl: number;
  shutdownGrace: number;
  progressFlush: number;
  /** Cap per run for each of the `log`, `message` and `progress` journal kinds. */
  runLogLimit: number;
  maxStepResultBytes: number;
  retention: { enabled: boolean; schedule: string; runs: Duration; logs: Duration; errors: Duration };
  events: { pollInterval: number };
  cli: { http?: { baseUrl: string; headers?: Record<string, string> } };
  schedules: ConfigScheduleEntry[];
}

export const SCHEDULER_DEFAULTS: SchedulerConfig = {
  enabled: true,
  tick: 1000,
  leaseTtl: 60_000,
  shutdownGrace: 30_000,
  progressFlush: 1000,
  runLogLimit: 1000,
  maxStepResultBytes: 65_536,
  retention: { enabled: true, schedule: '30 3 * * *', runs: '30d', logs: '7d', errors: '90d' },
  events: { pollInterval: 1000 },
  cli: {},
  schedules: [],
};

export function resolveSchedulerConfig(raw?: Partial<SchedulerConfig> | null): SchedulerConfig {
  const r = raw ?? {};
  return {
    ...SCHEDULER_DEFAULTS,
    ...r,
    retention: { ...SCHEDULER_DEFAULTS.retention, ...(r.retention ?? {}) },
    events: { ...SCHEDULER_DEFAULTS.events, ...(r.events ?? {}) },
    cli: { ...SCHEDULER_DEFAULTS.cli, ...(r.cli ?? {}) },
    schedules: r.schedules ?? [],
  };
}
