import type { RetryPolicyOptions } from '@spinajs/durable';
import type { Log } from '@spinajs/log-common';
import type { QueueEvent, QueueJob } from '@spinajs/queue';

export const WORKFLOW_STATUSES = ['running', 'sleeping', 'waiting', 'compensating', 'completed', 'failed', 'compensated', 'cancelled'] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

const STATUSES: ReadonlySet<string> = new Set(WORKFLOW_STATUSES);

export const isWorkflowStatus = (value: string): value is WorkflowStatus => STATUSES.has(value);

export const TERMINAL_STATUSES: readonly WorkflowStatus[] = ['completed', 'failed', 'compensated', 'cancelled'];

export const isTerminal = (status: WorkflowStatus): boolean => TERMINAL_STATUSES.includes(status);

export type StepKind = 'step' | 'sleep' | 'wait' | 'emit' | 'marker' | 'compensate';

/** `retrying`: this attempt failed and another one is due; `failed`: final, a replay rethrows it. */
export type StepStatus = 'pending' | 'succeeded' | 'retrying' | 'failed';

export type EventState = 'pending' | 'consumed' | 'rejected';

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  step?: string;
  details?: unknown;
}

/** What a blocking step row needs to resolve the same way on every replay. */
export interface StepMeta {
  wakeAt?: number;
  timeoutAt?: number | null;
  permission?: string;
  resource?: Record<string, unknown>;
  compensate?: boolean;
  /** Results delivered to run() before this operation was called, in its activation. */
  after?: number;
  /** Delivery position among the instance's results; a replay hands them back in this order. */
  order?: number;
  /** The call's number among the calls of its branch, from 1; a replay finds the recorded call by it. */
  call?: number;
}

export interface WorkflowOptions {
  /** Default 1. An instance stays on the version it started with (D5). */
  version?: number;
  /** Default policy of this workflow's steps. */
  retry?: RetryPolicyOptions;
  /** Whole-instance deadline counted from its start, e.g. '7d'. */
  timeout?: string;
}

export interface WorkflowStepOptions<T> {
  retry?: RetryPolicyOptions;
  /** `fn` and the journal row commit in one transaction on the workflow connection (D4). */
  transactional?: boolean;
  /** Registered once the step succeeds; runs newest first when the workflow fails (D6). No durable operations inside: the context is narrowed. */
  compensate?: (result: T, ctx: CompensationContext) => Promise<void>;
  /** Default true. `false`: the value is not stored; a replay resolves `undefined` without running the step. */
  persistResult?: boolean;
}

export interface WaitForEventOptions {
  timeout?: string | number;
  permission?: string;
  resource?: Record<string, unknown>;
}

export interface WorkflowEvent<T = unknown> {
  name: string;
  payload: T;
  principal?: string;
  receivedAt: number;
}

export interface WorkflowAllOptions {
  /** How many branches run at a time; all of them when absent. An item keeps the branch of its index either way. */
  concurrency?: number;
}

export interface WorkflowContext<TInput = unknown> {
  readonly instanceId: string;
  readonly workflow: string;
  readonly version: number;
  readonly input: TInput;
  readonly signal: AbortSignal;
  readonly log: Log;
  step<T>(name: string, fn: (s: { signal: AbortSignal; attempt: number }) => Promise<T> | T, opts?: WorkflowStepOptions<T>): Promise<T>;
  sleep(duration: string | number, name?: string): Promise<void>;
  sleepUntil(at: number | Date, name?: string): Promise<void>;
  /** Consumes the oldest pending event of `name` in insert order; `undefined` on timeout. */
  waitForEvent<T = unknown>(name: string, opts?: WaitForEventOptions): Promise<WorkflowEvent<T> | undefined>;
  emit(name: string, message: QueueEvent | QueueJob): Promise<void>;
  /** Runs `fn` in a branch of its own, named by `name`: its durable calls are counted apart, whatever `fn` awaits first. Writes no journal row. */
  branch<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  /**
   * One branch per item, named by its index, with the results in item order. Use it instead of
   * `Promise.all(items.map(...))` when a branch may await non-durable work before its first durable call, and
   * instead of a concurrency limiter.
   */
  all<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R> | R, opts?: WorkflowAllOptions): Promise<R[]>;
  now(): number;
  uuid(): string;
  random(): number;
  fail(reason: string, details?: unknown): never;
}

/** What a compensation sees: the instance's identity and input, the abort signal and the log. No durable operations (D6). */
export type CompensationContext = Pick<WorkflowContext, 'instanceId' | 'workflow' | 'version' | 'input' | 'signal' | 'log'>;

export interface StartOptions {
  id?: string;
  version?: number;
}

export interface WorkflowInstanceView {
  id: string;
  workflow: string;
  version: number;
  status: WorkflowStatus;
  reason: string | null;
  input: unknown;
  result: unknown;
  error: SerializedError | null;
  wakeAt: number | null;
  waitingFor: string | null;
  attempt: number;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface WorkflowStepView {
  seq: number;
  key: string;
  kind: StepKind;
  status: StepStatus;
  attempt: number;
  error: SerializedError | null;
  startedAt: number;
  finishedAt: number | null;
}

/** Payloads are left out: an operator reading the instance need not see what a signaller sent. */
export interface WorkflowEventView {
  id: string;
  name: string;
  principal: string | null;
  receivedAt: number;
}

export interface WorkflowInstanceDetail extends WorkflowInstanceView {
  steps: WorkflowStepView[];
  pendingEvents: WorkflowEventView[];
}
