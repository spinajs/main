import { AsyncService } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'retrying' | 'dead' | 'aborted' | 'emitted' | 'skipped' | 'misfired';
/** A run never passes through `failed` or `aborted` on its way to `retrying`, so these are final. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'dead', 'aborted', 'skipped', 'misfired'];
export const RETRYABLE_RUN_STATUSES: readonly RunStatus[] = ['failed', 'dead', 'aborted'];
export type RunTrigger = 'schedule' | 'manual' | 'retry' | 'catch-up';
export type AbortReason = 'cancelled' | 'timeout' | 'lease-lost' | 'lease-expired' | 'shutdown';
export type StepStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'aborted';
export type ScheduleHealth = 'ok' | 'failing' | 'paused-by-failures';
export type ErrorGroupStatus = 'open' | 'resolved' | 'ignored';
export type RunLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export type SpecKind = 'cron' | 'every' | 'at' | 'manual';

export interface TriggeredBy {
  kind: 'user' | 'service' | 'token' | 'system';
  id: string;
  name?: string;
}

export interface StructuredError {
  name: string;
  message: string;
  code?: string | number;
  stack?: string;
  step?: string;
  attempt: number;
  occurredAt: string;
  data?: unknown;
}

export interface ScheduleSpecInfo {
  kind: SpecKind;
  expression: string;
  timezone: string;
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  trigger: RunTrigger;
  progress: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ScheduleInfo {
  name: string;
  spec: ScheduleSpecInfo;
  runOn: 'leader' | 'all';
  mode: 'inline' | 'emit';
  enabled: boolean;
  paused: boolean;
  pausedReason: 'manual' | 'failures' | null;
  hardPaused: boolean;
  nextRunAt: string | null;
  health: ScheduleHealth;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastRun: RunSummary | null;
  running: boolean;
  orphaned: boolean;
  paramsSchema: object | null;
}

export interface ErrorGroupInfo {
  schedule: string;
  fingerprint: string;
  name: string;
  sampleMessage: string;
  sampleStack: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  lastRunId: string | null;
  status: ErrorGroupStatus;
}

export interface RunInfo {
  id: string;
  schedule: string;
  trigger: RunTrigger;
  triggeredBy: TriggeredBy | null;
  parentRunId: string | null;
  params: Record<string, unknown> | null;
  status: RunStatus;
  reason: string | null;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  scheduledAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  durationMs: number | null;
  progress: number;
  currentStep: string | null;
  message: string | null;
  result: unknown;
  error: StructuredError | null;
  jobId: string | null;
  cancelRequested: boolean;
  stale: boolean;
}

export interface StepInfo {
  attempt: number;
  seq: number;
  name: string;
  status: StepStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  progress: number;
  done: number | null;
  total: number | null;
  message: string | null;
  error: StructuredError | null;
}

export interface AttemptInfo {
  attempt: number;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: StructuredError | null;
}

export interface ScheduleDetail extends ScheduleInfo {
  definition: Record<string, unknown>;
  recentRuns: RunInfo[];
  openErrors: ErrorGroupInfo[];
}

export interface RunDetail extends RunInfo {
  attempts: AttemptInfo[];
  steps: StepInfo[];
  /** Last 200 `log` / `message` / `error` events, oldest first. */
  logs: RunEvent[];
  checkpoint: unknown;
}

export interface RunFilter {
  schedule?: string;
  status?: RunStatus | RunStatus[];
  trigger?: RunTrigger | RunTrigger[];
  from?: string | Date;
  to?: string | Date;
  /** Default 50, maximum 500. */
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ErrorFilter {
  schedule?: string;
  status?: ErrorGroupStatus | ErrorGroupStatus[];
}

export interface ActionContext {
  triggeredBy: TriggeredBy;
}

export interface RunNowOptions extends ActionContext {
  params?: Record<string, unknown>;
  force?: boolean;
  /** true = wait without limit; `{ timeoutMs }` = give up waiting (the run continues). */
  wait?: boolean | { timeoutMs: number };
}

export interface RunNowResult {
  runId: string;
  /** Present when `wait` was requested: the run as it was when waiting ended. */
  run?: RunInfo;
}

export interface RetryOptions extends ActionContext {
  fromStep?: string;
  params?: Record<string, unknown>;
  /** Defaults to the schedule's `resumable`. */
  resume?: boolean;
}

export interface PauseOptions extends ActionContext {
  hard?: boolean;
}

export interface PruneResult {
  orphanedSchedules: number;
  runs: number;
  logs: number;
  errors: number;
}

interface RunEventBase {
  /** Global journal position (`Pos`), commit-ordered across replicas. SSE id of schedule streams. */
  id: number;
  /** Per-run sequence, starts at 1. SSE id of run streams. */
  seq: number;
  runId: string;
  schedule: string;
  attempt: number;
  ts: string;
}

export type RunEvent =
  | (RunEventBase & { type: 'status'; status: RunStatus; reason: string | null })
  | (RunEventBase & { type: 'step-start'; step: string; stepSeq: number })
  | (RunEventBase & { type: 'step-end'; step: string; stepSeq: number; status: StepStatus; durationMs: number; error?: StructuredError })
  | (RunEventBase & { type: 'progress'; progress: number; step: string | null; stepProgress: number | null; done?: number; total?: number; message?: string; synthetic?: true })
  | (RunEventBase & { type: 'message'; message: string; level: RunLogLevel; step: string | null })
  | (RunEventBase & { type: 'log'; level: RunLogLevel; message: string; step: string | null; data?: unknown })
  | (RunEventBase & { type: 'error'; error: StructuredError });

export type RunEventType = RunEvent['type'];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What producers pass to the journal; the writer fills the identity fields. */
export type RunEventPayload = DistributiveOmit<RunEvent, keyof RunEventBase>;

export type SubscribeTarget = { runId: string } | { schedule: string };
export interface SubscribeOptions {
  /**
   * Last seen `seq` (run target) or `id` (schedule target); events after it are replayed first.
   * Omitted: a run target replays from its first event, a schedule target is live only.
   */
  after?: number;
}
export type RunEventListener = (event: RunEvent) => void;
export type Unsubscribe = () => void;

export abstract class SchedulerService extends AsyncService {
  public abstract listSchedules(): Promise<ScheduleInfo[]>;
  public abstract getSchedule(name: string): Promise<ScheduleDetail>;
  public abstract runNow(name: string, options: RunNowOptions): Promise<RunNowResult>;
  public abstract listRuns(filter?: RunFilter): Promise<Page<RunInfo>>;
  public abstract getRun(id: string): Promise<RunDetail>;
  public abstract subscribe(target: SubscribeTarget, listener: RunEventListener, options?: SubscribeOptions): Promise<Unsubscribe>;
  public abstract cancel(runId: string, ctx: ActionContext): Promise<RunInfo>;
  public abstract retry(runId: string, options: RetryOptions): Promise<RunNowResult>;
  public abstract retryFailed(name: string, since: Date | string, ctx: ActionContext): Promise<{ runIds: string[] }>;
  public abstract pause(name: string, options: PauseOptions): Promise<ScheduleInfo>;
  public abstract resume(name: string, ctx: ActionContext): Promise<ScheduleInfo>;
  public abstract listErrors(filter?: ErrorFilter): Promise<ErrorGroupInfo[]>;
  public abstract setErrorStatus(fingerprint: string, status: ErrorGroupStatus, ctx: ActionContext): Promise<ErrorGroupInfo>;
  public abstract prune(ctx: ActionContext): Promise<PruneResult>;
}

export class ScheduleNotFound extends ResourceNotFound {
  constructor(public readonly schedule: string) {
    super(`Schedule '${schedule}' not found`);
  }
}

export class RunNotFound extends ResourceNotFound {
  constructor(public readonly runId: string) {
    super(`Run '${runId}' not found`);
  }
}

export class ErrorGroupNotFound extends ResourceNotFound {
  constructor(public readonly fingerprint: string) {
    super(`Error group '${fingerprint}' not found`);
  }
}

export class RunConflict extends ResourceDuplicated {
  constructor(message: string, public readonly runId: string | null) {
    super(message);
  }
}

export class InvalidRunState extends InvalidOperation {
  constructor(message: string, public readonly status: RunStatus) {
    super(message);
  }
}

export class SchedulePaused extends InvalidOperation {
  constructor(public readonly schedule: string) {
    super(`Schedule '${schedule}' is hard-paused; manual runs are disabled`);
  }
}

export interface ParamError {
  path: string;
  message: string;
}

export class InvalidRunParams extends InvalidArgument {
  constructor(message: string, public readonly errors: ParamError[]) {
    super(message);
  }
}

export type SchedulerErrorCode = 'not-found' | 'conflict' | 'invalid-params' | 'invalid-state' | 'error';

export function errorCodeFor(err: unknown): SchedulerErrorCode {
  if (err instanceof ScheduleNotFound || err instanceof RunNotFound || err instanceof ErrorGroupNotFound) return 'not-found';
  if (err instanceof RunConflict) return 'conflict';
  if (err instanceof InvalidRunParams) return 'invalid-params';
  if (err instanceof InvalidRunState || err instanceof SchedulePaused) return 'invalid-state';
  return 'error';
}

const HTTP_STATUS: Record<SchedulerErrorCode, number> = { 'not-found': 404, conflict: 409, 'invalid-params': 400, 'invalid-state': 409, error: 500 };
const EXIT_CODE: Record<SchedulerErrorCode, number> = { 'not-found': 4, conflict: 3, 'invalid-params': 2, 'invalid-state': 3, error: 1 };

export const SCHEDULER_EXIT_OK = 0;
export const SCHEDULER_EXIT_RUN_FAILED = 1;

export function httpStatusForError(err: unknown): number {
  return HTTP_STATUS[errorCodeFor(err)];
}

export function exitCodeForError(err: unknown): number {
  return EXIT_CODE[errorCodeFor(err)];
}

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export function isTerminalEvent(e: RunEvent): boolean {
  return e.type === 'status' && isTerminalStatus(e.status);
}

export function sseEventId(target: SubscribeTarget, e: RunEvent): string {
  return 'runId' in target ? String(e.seq) : String(e.id);
}

export function parseSseEventId(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function formatSseEvent(target: SubscribeTarget, e: RunEvent): string {
  return `id: ${sseEventId(target, e)}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

export const SCHEDULER_SSE_HEARTBEAT_MS = 15000;

export const SCHEDULER_PERMISSIONS = { read: 'scheduler:read', run: 'scheduler:run', manage: 'scheduler:manage' } as const;
export const SCHEDULER_RBAC = { resource: 'scheduler', read: 'readAny', run: 'updateAny', manage: 'deleteAny' } as const;
