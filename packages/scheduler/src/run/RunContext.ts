import { InvalidOperation } from '@spinajs/exceptions';
import type { Log } from '@spinajs/log-common';
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
  /** Expected total step weight (R10); 0 when unknown. */
  plannedWeight?: number;
  onStepFinished?: (step: string, status: StepStatus, durationMs: number) => Promise<void>;
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
  }

  /** Total weight of the steps this run goes through (R10); overrides the previous run's. */
  public expectSteps(totalWeight: number): void {
    this.plannedWeight = Math.max(0, totalWeight);
    this.touch();
  }

  public async step<T>(name: string, fn: (s: StepHandle) => Promise<T> | T, opts: StepOptions = {}): Promise<T> {
    if (this.open) {
      throw new InvalidOperation(`step '${name}' started inside step '${this.open.name}'; steps run one after another`);
    }
    if (this.signal.aborted) throw new RunAbortedError(this.signal.reason as never);
    if (this.closed) throw new InvalidOperation(`run ${this.runId} has finished; step '${name}' was not started`);

    const weight = opts.weight ?? 1;
    const occurrence = (this.occurrences.get(name) ?? 0) + 1;
    this.occurrences.set(name, occurrence);
    const seq = ++this.stepSeq;
    const startedAt = this.init.clock.now();

    const row = await RunStepModel.create({
      RunId: this.runId,
      Attempt: this.attempt,
      Seq: seq,
      Name: name,
      Status: 'running',
      Weight: weight,
      StartedAt: startedAt,
      Progress: 0,
    });
    const s: OpenStep = { name, seq, rowId: row.Id, weight, startedAt, fraction: 0, message: null, closed: false };
    this.open = s;
    this.currentStepName = name;
    this.dropPendingProgress();
    this.touch();
    await this.emit({ type: 'step-start', step: name, stepSeq: seq });

    try {
      const value = await fn(this.handle(name));
      await this.closeStep(s, 'succeeded', null, opts.persistResult === false ? undefined : value);
      return value;
    } catch (err) {
      const aborted = this.signal.aborted;
      const error = aborted
        ? null
        : toStructuredError(err, { attempt: this.attempt, occurredAt: this.init.clock.now(), step: name });
      if (err !== null && typeof err === 'object') this.stepErrors.set(err as object, name);
      await this.closeStep(s, aborted ? 'aborted' : 'failed', error, undefined);
      throw err;
    }
  }

  /** A number 0..100 or `{ done, total }`; applies to the open step, or to the whole run outside steps. */
  public progress(p: ProgressInput): void {
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
    if (this.closed || !changed) return;
    const open = this.open;
    if (open && !open.closed) {
      void this.enqueue(() =>
        RunStepModel.update(
          defined({
            Progress: Math.round(open.fraction * 100),
            Done: open.done,
            Total: open.total,
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
    if (s && !s.closed) await this.closeStep(s, 'aborted', null, undefined);
    this.closed = true;
    await this.queue;
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

  /** A task still running after its grace period must not write past the run's final status. */
  protected emit(payload: RunEventPayload): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.enqueue(() => this.init.events.write(this.init.run, this.attempt, payload));
  }

  protected async closeStep(
    s: OpenStep,
    status: StepStatus,
    error: StructuredError | null,
    value: unknown,
  ): Promise<void> {
    if (s.closed) return;
    s.closed = true;
    if (this.open === s) {
      this.open = null;
      this.currentStepName = null;
    }
    if (status === 'aborted') this.abortedStep = s.name;
    const now = this.init.clock.now();
    const json = value === undefined ? null : safeJson(value);
    const result = json !== null && json.length <= this.init.config.maxStepResultBytes ? json : undefined;
    await this.enqueue(() =>
      RunStepModel.update(
        defined({
          Status: status,
          FinishedAt: now,
          Progress: status === 'succeeded' ? 100 : Math.round(s.fraction * 100),
          Done: s.done,
          Total: s.total,
          Message: s.message,
          Result: result,
          Error: jsonColumn(error) as never,
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
