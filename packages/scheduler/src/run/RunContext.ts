import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import type { Log, LogVariables } from '@spinajs/log-common';
import type {
  RunEventPayload,
  RunLogLevel,
  RunTrigger,
  StepStatus,
  StructuredError,
  TriggeredBy,
} from '../contract.js';
import { RunAbortedError } from '../errors.js';
import type { ScheduleDefinition, SchedulerConfig } from '../interfaces.js';
import { defined, jsonColumn } from '../models/converters.js';
import type { RunModel } from '../models/RunModel.js';
import { RunStepModel } from '../models/RunStepModel.js';
import type { RunProgressPatch } from '../store/LeaseStore.js';
import type { DbClock } from '../time/clock.js';
import { safeJson, toStructuredError } from '../tracking/structured.js';
import type { ExecutionOutcome } from './outcome.js';
import { computeRunProgress, normalizeProgress, ProgressInput } from './progress.js';
import type { RunEventWriter } from './RunEventWriter.js';

export interface RunContextInit {
  run: RunModel;
  def: ScheduleDefinition;
  signal: AbortSignal;
  events: RunEventWriter;
  clock: DbClock;
  log: Log;
  config: SchedulerConfig;
  /** Expected total step weight; 0 when unknown. */
  plannedWeight?: number;
  onStepFinished?: (step: string, status: StepStatus, durationMs: number) => Promise<void>;
  /** Writes the checkpoint to the run row while this replica still owns the run; `false` when it does not. */
  saveCheckpoint: (value: unknown) => Promise<boolean>;
  /** Called when a write proves another replica owns the run; the executor aborts the run with `lease-lost`. */
  onLeaseLost?: () => void;
  /** Results of steps completed by an earlier attempt, keyed `${name}#${occurrence}`. */
  resume?: Map<string, unknown> | null;
  /** Starts the run without the checkpoint stored on its row (a retry that does not resume). */
  discardCheckpoint?: boolean;
}

export interface StepOptions {
  /** Share of the run's progress relative to the other steps. Default 1. */
  weight?: number;
  /** `false` keeps the step's return value out of the step row. */
  persistResult?: boolean;
}

export interface StepHandle {
  readonly name: string;
  readonly signal: AbortSignal;
  progress(p: ProgressInput): void;
  message(text: string, level?: RunLogLevel): void;
}

/** Lines go to the app log; `info` and above are also journaled as `log` events (capped by `runLogLimit`). */
export interface RunLogger {
  trace(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** Width of the step name columns (step row, the run's `CurrentStep`, the journal's `Step`). */
const MAX_STEP_NAME = 128;
/** `__scheduler_run_step.Weight` is DECIMAL(16,4). */
const MAX_WEIGHT = 1e12;

function checkWeight(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0 || value >= MAX_WEIGHT) {
    throw new InvalidArgument(`${what} must be a finite number >= 0 and below 1e12, got ${value}`);
  }
  return value;
}

function checkStepName(name: string): void {
  const length = [...name].length;
  if (length > MAX_STEP_NAME) {
    throw new InvalidArgument(
      `step name must be at most ${MAX_STEP_NAME} characters, got ${length}: '${name.slice(0, 40)}...'`,
    );
  }
}

/** `Done` / `Total` are DECIMAL(24,4); a JS number is exact up to 2^53 anyway. */
function checkCount(value: number, what: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new InvalidArgument(`progress ${what} must be a finite number of at most 2^53 - 1, got ${value}`);
  }
}

interface OpenStep {
  name: string;
  seq: number;
  rowId: number;
  weight: number;
  startedAt: number;
  fraction: number;
  done?: number;
  total?: number;
  message: string | null;
  closed: boolean;
}

/**
 * What a running task sees. Progress and messages only change memory; the executor's heartbeat
 * flushes them (`snapshot()`, then `markFlushed()`) at most every `progressFlush`. Every journal
 * and step-row write goes through one queue, so events keep the order the task produced them in.
 */
export class RunContext {
  public readonly runId: string;
  public readonly schedule: string;
  public readonly trigger: RunTrigger;
  public readonly attempt: number;
  public readonly scheduledAt: Date | null;
  public readonly firedAt: Date;
  public readonly params: Record<string, unknown>;
  public readonly triggeredBy: TriggeredBy | null;
  public readonly signal: AbortSignal;
  public readonly log: RunLogger;

  public currentStepName: string | null = null;

  protected resultValue: unknown = undefined;
  protected hasResult = false;
  protected stepSeq = 0;
  protected occurrences = new Map<string, number>();
  protected open: OpenStep | null = null;
  protected completedWeight = 0;
  protected plannedWeight: number;
  protected freeFraction: number | null = null;
  protected lastMessage: string | null;
  protected detail: { done?: number; total?: number; message?: string } = {};
  protected progressPending = false;
  protected lastEmittedProgress: number;
  /** Bumped on every change; a change made while a flush is in flight keeps the context dirty. */
  protected version = 0;
  protected snapshotVersion = 0;
  protected flushedVersion = 0;
  protected queue: Promise<void> = Promise.resolve();
  protected closed = false;
  /** Errors thrown out of a step: the run error still names the step after it closed. */
  protected stepErrors = new WeakMap<object, string>();
  protected abortedStep: string | null = null;
  /** A step whose row is being created; `open` is set only once the row exists. */
  protected starting: string | null = null;
  protected checkpointValue: unknown;

  constructor(protected readonly init: RunContextInit) {
    const r = init.run;
    this.runId = r.Id;
    this.schedule = r.Schedule;
    this.trigger = r.Trigger;
    this.attempt = r.Attempt;
    this.scheduledAt = r.ScheduledAt ? new Date(r.ScheduledAt) : null;
    this.firedAt = new Date(r.StartedAt ?? init.clock.now());
    this.params = r.Params ?? {};
    this.triggeredBy = r.TriggeredBy ?? null;
    this.signal = init.signal;
    this.plannedWeight = init.plannedWeight ?? 0;
    this.lastMessage = r.Message ?? null;
    this.lastEmittedProgress = r.Progress ?? 0;
    this.checkpointValue = init.discardCheckpoint ? null : r.Checkpoint ?? null;
    this.log = this.createLogger();
  }

  /** Total weight of the steps this run goes through; overrides the previous run's. */
  public expectSteps(totalWeight: number): void {
    this.plannedWeight = checkWeight(totalWeight, 'expectSteps(totalWeight)');
    this.touch();
  }

  public async step<T>(name: string, fn: (s: StepHandle) => Promise<T> | T, opts: StepOptions = {}): Promise<T> {
    const outer = this.open?.name ?? this.starting;
    if (outer !== null) {
      throw new InvalidOperation(`step '${name}' started inside step '${outer}'; steps run one after another`);
    }
    if (this.signal.aborted) throw new RunAbortedError(this.signal.reason as never);
    if (this.closed) throw new InvalidOperation(`run ${this.runId} has finished; step '${name}' was not started`);

    checkStepName(name);
    const weight = checkWeight(opts.weight ?? 1, `weight of step '${name}'`);
    const occurrence = (this.occurrences.get(name) ?? 0) + 1;
    this.occurrences.set(name, occurrence);
    const seq = ++this.stepSeq;
    const startedAt = this.init.clock.now();
    const key = `${name}#${occurrence}`;
    if (this.init.resume?.has(key)) {
      this.starting = name;
      try {
        return (await this.skipStep(name, seq, weight, startedAt, this.init.resume.get(key))) as T;
      } finally {
        this.starting = null;
      }
    }

    this.starting = name;
    let row: RunStepModel;
    try {
      row = await RunStepModel.create({
        RunId: this.runId,
        Attempt: this.attempt,
        Seq: seq,
        Name: name,
        Status: 'running',
        Weight: weight,
        StartedAt: startedAt,
        Progress: 0,
      });
    } finally {
      this.starting = null;
    }
    if (this.closed) {
      // the run ended while the row was being created: nothing may be journaled any more
      await RunStepModel.update({ Status: 'aborted', FinishedAt: this.init.clock.now() }).where('Id', row.Id);
      throw new InvalidOperation(`run ${this.runId} has finished; step '${name}' was not started`);
    }
    const s: OpenStep = { name, seq, rowId: row.Id, weight, startedAt, fraction: 0, message: null, closed: false };
    this.open = s;
    this.currentStepName = name;
    this.dropPendingProgress();
    this.touch();
    await this.emit({ type: 'step-start', step: name, stepSeq: seq });

    try {
      const value = await fn(this.handle(name));
      await this.closeStep(s, 'succeeded', null, opts.persistResult === false ? undefined : { value });
      return value;
    } catch (err) {
      const aborted = this.signal.aborted;
      const error = aborted
        ? null
        : toStructuredError(err, { attempt: this.attempt, occurredAt: this.init.clock.now(), step: name });
      if (err !== null && typeof err === 'object') this.stepErrors.set(err as object, name);
      await this.closeStep(s, aborted ? 'aborted' : 'failed', error);
      throw err;
    }
  }

  /** A number 0..100 or `{ done, total }`; applies to the open step, or to the whole run outside steps. */
  public progress(p: ProgressInput): void {
    if (typeof p !== 'number') {
      checkCount(p.done, 'done');
      checkCount(p.total, 'total');
    }
    const n = normalizeProgress(p);
    if (this.open) {
      this.open.fraction = n.fraction;
      this.open.done = n.done;
      this.open.total = n.total;
      if (n.message !== undefined) this.open.message = n.message;
    } else {
      this.freeFraction = n.fraction;
    }
    if (n.message !== undefined) this.lastMessage = n.message;
    this.detail = { done: n.done, total: n.total, message: n.message };
    this.progressPending = true;
    this.touch();
  }

  /** A status line: journaled at once (capped by `runLogLimit`), the run's `Message` from the next flush. */
  public message(text: string, level: RunLogLevel = 'info'): void {
    this.lastMessage = text;
    if (this.open) this.open.message = text;
    this.touch();
    void this.emit({ type: 'message', message: text, level, step: this.currentStepName });
  }

  public get overallProgress(): number {
    return computeRunProgress({
      completedWeight: this.completedWeight,
      currentWeight: this.open?.weight ?? null,
      currentFraction: this.open?.fraction ?? 0,
      plannedWeight: this.plannedWeight,
      freeProgress: this.freeFraction,
    });
  }

  /** Stored as the run's result instead of the task's return value. */
  public result(data: unknown): void {
    this.resultValue = data;
    this.hasResult = true;
  }

  public get explicitResult(): { set: boolean; value: unknown } {
    return { set: this.hasResult, value: this.resultValue };
  }

  /** The run row's checkpoint when the run started, then the last one saved. */
  public get lastCheckpoint(): unknown {
    return this.checkpointValue;
  }

  /** Persists JSON `data` on the run row; throws `RunAbortedError('lease-lost')` once another replica owns the run. */
  public async checkpoint(data: unknown): Promise<void> {
    const json = safeJson(data);
    if (json === null) throw new InvalidArgument('checkpoint data must be JSON-serializable');
    const value = JSON.parse(json) as unknown;
    if (!(await this.init.saveCheckpoint(value))) {
      // abort before the task sees the error, so its step-end and later lines are not journaled
      this.init.onLeaseLost?.();
      throw new RunAbortedError('lease-lost');
    }
    this.checkpointValue = value;
  }

  public get dirty(): boolean {
    return this.version !== this.flushedVersion;
  }

  /** The step a failed or aborted run is attributed to. */
  public stepOf(outcome: ExecutionOutcome): string | null {
    if (this.currentStepName !== null) return this.currentStepName;
    if (outcome.kind === 'error' && outcome.error !== null && typeof outcome.error === 'object') {
      return this.stepErrors.get(outcome.error) ?? null;
    }
    return outcome.kind === 'aborted' ? this.abortedStep : null;
  }

  public snapshot(): RunProgressPatch {
    this.snapshotVersion = this.version;
    return { Progress: this.overallProgress, CurrentStep: this.currentStepName, Message: this.lastMessage };
  }

  /** The run row got the last `snapshot()`: writes the open step's row and, when it moved, one `progress` event. */
  public markFlushed(): void {
    const changed = this.snapshotVersion !== this.flushedVersion;
    this.flushedVersion = this.snapshotVersion;
    if (this.muted || !changed) return;
    const open = this.open;
    if (open && !open.closed) {
      void this.enqueue(() =>
        RunStepModel.update(
          defined({
            Progress: Math.round(open.fraction * 100),
            // null, not undefined: a plain number after { done, total } must clear them
            Done: open.done ?? null,
            Total: open.total ?? null,
            Message: open.message,
          }),
        ).where('Id', open.rowId),
      );
    }
    const progress = this.overallProgress;
    if (!this.progressPending && progress === this.lastEmittedProgress) return;
    this.progressPending = false;
    this.lastEmittedProgress = progress;
    void this.emit({
      type: 'progress',
      progress,
      step: this.currentStepName,
      stepProgress: open ? Math.round(open.fraction * 100) : null,
      ...defined(this.detail),
    });
  }

  /** Ends a step the task left open (it did not settle after an abort) and waits for every queued write. */
  public async close(_outcome: ExecutionOutcome): Promise<void> {
    const s = this.open;
    if (s && !s.closed) await this.closeStep(s, 'aborted', null);
    this.closed = true;
    await this.queue;
  }

  /** A step an earlier attempt completed: recorded as `skipped` with the stored result, `fn` is not called. */
  protected async skipStep(name: string, seq: number, weight: number, now: number, value: unknown): Promise<unknown> {
    await this.enqueue(() =>
      RunStepModel.create({
        RunId: this.runId,
        Attempt: this.attempt,
        Seq: seq,
        Name: name,
        Status: 'skipped',
        Weight: weight,
        StartedAt: now,
        FinishedAt: now,
        Progress: 100,
        Result: jsonColumn(value),
        ResultStored: true,
      }),
    );
    this.completedWeight += weight;
    this.dropPendingProgress();
    this.touch();
    await this.emit({ type: 'step-start', step: name, stepSeq: seq });
    await this.emit({ type: 'step-end', step: name, stepSeq: seq, status: 'skipped', durationMs: 0 });
    return value;
  }

  protected createLogger(): RunLogger {
    // LogVariables also types the per-line built-ins (level, message, ...), which the logger fills itself
    const vars = { runId: this.runId, schedule: this.schedule, attempt: this.attempt } as unknown as LogVariables;
    const base = this.init.log.child('SCHEDULER', vars);
    const write = (level: RunLogLevel, message: string, data?: unknown) => {
      const fields: Record<string, unknown> = { step: this.currentStepName };
      if (data !== undefined) fields.data = data;
      base[level](fields, message);
      if (level === 'trace' || level === 'debug') return;
      const json = data === undefined ? null : safeJson(data);
      void this.emit({
        type: 'log',
        level,
        message,
        step: this.currentStepName,
        ...(json !== null ? { data: JSON.parse(json) as unknown } : {}),
      });
    };
    return {
      trace: (m, d) => write('trace', m, d),
      debug: (m, d) => write('debug', m, d),
      info: (m, d) => write('info', m, d),
      warn: (m, d) => write('warn', m, d),
      error: (m, d) => write('error', m, d),
    };
  }

  protected handle(name: string): StepHandle {
    return { name, signal: this.signal, progress: (p) => this.progress(p), message: (t, l) => this.message(t, l) };
  }

  protected touch(): void {
    this.version++;
  }

  /** A step event supersedes a progress value that was not flushed yet. */
  protected dropPendingProgress(): void {
    this.progressPending = false;
    this.detail = {};
  }

  protected enqueue(work: () => PromiseLike<unknown>): Promise<void> {
    const next = this.queue.then(work).then(
      () => undefined,
      (err) => this.init.log.warn(`run ${this.runId}: write failed: ${(err as Error).message}`),
    );
    this.queue = next;
    return next;
  }

  /**
   * Nothing is journaled once the context is closed (a task still running after its grace period)
   * or the lease is lost: the replica that took the run over journals its final status itself.
   */
  protected get muted(): boolean {
    return this.closed || (this.signal.aborted && this.signal.reason === 'lease-lost');
  }

  protected emit(payload: RunEventPayload): Promise<void> {
    if (this.muted) return Promise.resolve();
    return this.enqueue(() => this.init.events.write(this.init.run, this.attempt, payload));
  }

  protected async closeStep(
    s: OpenStep,
    status: StepStatus,
    error: StructuredError | null,
    /** The return value to keep; absent for a failed step or `persistResult: false`. */
    kept?: { value: unknown },
  ): Promise<void> {
    if (s.closed) return;
    s.closed = true;
    if (this.open === s) {
      this.open = null;
      this.currentStepName = null;
    }
    if (status === 'aborted') this.abortedStep = s.name;
    const now = this.init.clock.now();
    const json = kept === undefined || kept.value === undefined ? null : safeJson(kept.value);
    const fits = json !== null && json.length <= this.init.config.maxStepResultBytes;
    // a step that returned nothing has nothing to lose; one whose value was dropped must run again on resume
    const stored = kept !== undefined && (kept.value === undefined || fits);
    await this.enqueue(() =>
      RunStepModel.update(
        defined({
          Status: status,
          FinishedAt: now,
          Progress: status === 'succeeded' ? 100 : Math.round(s.fraction * 100),
          Done: s.done ?? null,
          Total: s.total ?? null,
          Message: s.message,
          Result: fits ? kept?.value : undefined,
          ResultStored: stored,
          Error: error,
        }),
      ).where('Id', s.rowId),
    );
    if (status === 'succeeded') this.completedWeight += s.weight;
    this.dropPendingProgress();
    this.touch();
    await this.emit({
      type: 'step-end',
      step: s.name,
      stepSeq: s.seq,
      status,
      durationMs: now - s.startedAt,
      ...(error ? { error } : {}),
    });
    try {
      await this.init.onStepFinished?.(s.name, status, now - s.startedAt);
    } catch (err) {
      this.init.log.warn(`run ${this.runId}: step hook failed: ${(err as Error).message}`);
    }
  }
}
