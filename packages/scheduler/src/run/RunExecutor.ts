import { Autoinject, DI, Injectable, NewInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log-common';
import type { AbortReason, RunStatus, StructuredError } from '../contract.js';
import { RunAbortedError } from '../errors.js';
import { resolveSchedulerConfig, ScheduleDefinition, SchedulerConfig } from '../interfaces.js';
import { defined, jsonColumn } from '../models/converters.js';
import { RunAttemptModel } from '../models/RunAttemptModel.js';
import { RunModel } from '../models/RunModel.js';
import { RunStepModel } from '../models/RunStepModel.js';
import { automaticRetry, decideAfterFailure } from '../policy/retry.js';
import { SchedulerSignals } from '../signals.js';
import { LeaseStore } from '../store/LeaseStore.js';
import { Clock, DbClock } from '../time/clock.js';
import { safeJson, toStructuredError } from '../tracking/structured.js';
import { Heartbeat } from './Heartbeat.js';
import type { ExecutionOutcome } from './outcome.js';
import { RunContext } from './RunContext.js';
import { withRunContext } from './current.js';
import { RunEventWriter } from './RunEventWriter.js';
import { RunFinalizer } from './RunFinalizer.js';
import { loadResumeMap } from './resume.js';

export interface ExecutionHandle {
  runId: string;
  schedule: string;
  done: Promise<void>;
  abort(reason: AbortReason): void;
}

export interface RunDecision {
  status: RunStatus;
  reason: string | null;
  error: StructuredError | null;
  countsAsFailure: boolean;
  keepScheduleLease: boolean;
  nextAttemptAt: number | null;
}

/**
 * Runs one claimed run in this process. The run's signal aborts on timeout, cancel, lease loss or
 * shutdown; after that the task gets `shutdownGrace` to settle before the run is recorded.
 */
@NewInstance()
@Injectable()
export class RunExecutor {
  @Logger('SCHEDULER')
  protected Log: Log;

  @Autoinject(DbClock)
  protected Clock: DbClock;

  @Autoinject(Clock)
  protected Timers: Clock;

  @Autoinject(RunEventWriter)
  protected Events: RunEventWriter;

  @Autoinject(SchedulerSignals)
  protected Signals: SchedulerSignals;

  @Autoinject(RunFinalizer)
  protected Finalizer: RunFinalizer;

  @Config('scheduler', { defaultValue: {} })
  protected RawConfig: Partial<SchedulerConfig>;

  constructor(protected readonly Leases: LeaseStore) {}

  /** `run` must already be claimed by `Leases` (status `running`, this replica's lease). */
  public start(run: RunModel, def: ScheduleDefinition): ExecutionHandle {
    const ac = new AbortController();
    const abort = (reason: AbortReason) => {
      if (!ac.signal.aborted) ac.abort(reason);
    };
    const done = this.execute(run, def, ac, abort).catch((err) =>
      this.Log.error(err as Error, `run ${run.Id} crashed inside the executor`),
    );
    return { runId: run.Id, schedule: run.Schedule, done, abort };
  }

  protected async execute(
    run: RunModel,
    def: ScheduleDefinition,
    ac: AbortController,
    abort: (r: AbortReason) => void,
  ): Promise<void> {
    const cfg = resolveSchedulerConfig(this.RawConfig);
    const startedAt = this.Clock.now();
    let abortedAt: number | undefined;
    ac.signal.addEventListener('abort', () => (abortedAt = this.Timers.now()), { once: true });

    await RunAttemptModel.create({ RunId: run.Id, Attempt: run.Attempt, StartedAt: startedAt, Status: 'running' });
    await this.Events.write(run, run.Attempt, { type: 'status', status: 'running', reason: null });
    await this.Signals.runStarted(run, startedAt);

    const ctx = await this.createContext(run, def, ac.signal, cfg, () => abort('lease-lost'));
    const scheduleLease = run.Forced ? null : run.Schedule;
    const renewEveryMs = Math.floor(cfg.leaseTtl / 3);
    const heartbeat = new Heartbeat({
      timers: this.Timers,
      now: () => this.Clock.now(),
      intervalMs: Math.min(cfg.progressFlush, renewEveryMs),
      renewEveryMs,
      leaseTtlMs: cfg.leaseTtl,
      // the lease runs from the claim, not from here: the setup above already used part of it
      leaseStartedAt: run.LeaseUntil !== null ? run.LeaseUntil - this.Leases.LeaseTtl : startedAt,
      needsFlush: () => ctx.dirty,
      renew: async () => {
        const r = await this.Leases.renewRun(run.Id, run.Attempt, scheduleLease, this.Clock.now(), ctx.snapshot());
        if (r.ok) ctx.markFlushed();
        return r;
      },
      onLost: () => abort('lease-lost'),
      onCancel: () => abort('cancelled'),
      onError: (err) => this.Log.warn(err as Error, `lease renewal failed for run ${run.Id}`),
    });

    heartbeat.start();
    const timeout = def.timeoutMs ? this.Timers.setTimeout(() => abort('timeout'), def.timeoutMs) : undefined;

    let outcome: ExecutionOutcome;
    try {
      // a synchronous throw from an overridden invoke() is a task failure like any other
      const work = new Promise<unknown>((resolve) => resolve(this.invoke(def, ctx)));
      outcome = await this.settle(work, ac.signal, cfg.shutdownGrace);
    } finally {
      if (timeout !== undefined) this.Timers.clearTimeout(timeout);
      // after an abort the whole wind-down stays within shutdownGrace, even while a renewal hangs
      const graceLeft = abortedAt === undefined ? Infinity : abortedAt + cfg.shutdownGrace - this.Timers.now();
      await heartbeat.stop(Math.max(0, graceLeft));
    }

    try {
      await ctx.close(outcome);
      await this.complete(run, def, ctx, outcome);
    } finally {
      this.Events.forget(run.Id);
    }
  }

  protected async createContext(
    run: RunModel,
    def: ScheduleDefinition,
    signal: AbortSignal,
    cfg: SchedulerConfig,
    onLeaseLost?: () => void,
  ): Promise<RunContext> {
    // design §5/§8: only a resumable or resumed run continues from the previous attempt's checkpoint
    const discardCheckpoint = run.Attempt > 1 && !def.resumable && !run.ResumeFrom;
    return new RunContext({
      run,
      def,
      signal,
      events: this.Events,
      clock: this.Clock,
      log: this.Log,
      config: cfg,
      plannedWeight: await this.plannedWeight(def.name),
      onStepFinished: (step, status, ms) => this.Signals.stepFinished(run, step, status, ms),
      // fenced like every other write of the owner: a reaped or re-claimed run refuses it
      saveCheckpoint: (json) =>
        this.Leases.finishRun(run.Id, run.Attempt, { Checkpoint: json, UpdatedAt: this.Clock.now() }),
      onLeaseLost,
      resume: await loadResumeMap(run, def),
      discardCheckpoint,
    });
  }

  /** Only a best guess: a failed lookup must not stop a run that is already journaled `running`. */
  protected async plannedWeight(schedule: string): Promise<number> {
    try {
      return await this.lastSucceededWeight(schedule);
    } catch (err) {
      this.Log.warn(err as Error, `could not read the planned step weight of ${schedule}; using the steps seen`);
      return 0;
    }
  }

  /** Step weight of the schedule's last succeeded run: the best guess for this run's total (R10). */
  protected async lastSucceededWeight(schedule: string): Promise<number> {
    const last = await RunModel.where('Schedule', schedule)
      .where('Status', 'succeeded')
      .orderByDescending('FinishedAt')
      .first();
    if (!last) return 0;
    const steps = await RunStepModel.where('RunId', last.Id).where('Attempt', last.Attempt);
    return steps.reduce((sum, s) => sum + (s.Weight ?? 1), 0);
  }

  protected async invoke(def: ScheduleDefinition, ctx: RunContext): Promise<unknown> {
    const task = await Promise.resolve(DI.resolve(def.task));
    return withRunContext(ctx, () => Promise.resolve(task.execute(ctx)));
  }

  protected async settle(work: Promise<unknown>, signal: AbortSignal, graceMs: number): Promise<ExecutionOutcome> {
    const guarded = work.then(
      (value): ExecutionOutcome => ({ kind: 'ok', value }),
      (error): ExecutionOutcome => ({ kind: 'error', error }),
    );
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) return resolve('aborted');
      signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });

    const first = await Promise.race([guarded, aborted]);
    if (first !== 'aborted' && (first.kind === 'ok' || !signal.aborted)) return first;

    const graceAc = new AbortController();
    const settled = await Promise.race([
      guarded.then(() => true),
      this.Timers.sleep(graceMs, graceAc.signal).then(() => false),
    ]);
    graceAc.abort();
    return { kind: 'aborted', reason: signal.reason as AbortReason, settled };
  }

  protected decide(
    run: RunModel,
    def: ScheduleDefinition,
    outcome: ExecutionOutcome,
    now: number,
    step: string | null,
  ): RunDecision {
    if (outcome.kind === 'ok') {
      return {
        status: 'succeeded',
        reason: null,
        error: null,
        countsAsFailure: false,
        keepScheduleLease: false,
        nextAttemptAt: null,
      };
    }

    const abortReason = outcome.kind === 'aborted' ? outcome.reason : undefined;
    const raw = outcome.kind === 'error' ? outcome.error : new RunAbortedError(outcome.reason);
    const error =
      abortReason === 'cancelled' ? null : toStructuredError(raw, { attempt: run.Attempt, occurredAt: now, step });
    // a task still running may still need the schedule lease to keep others out
    const keepScheduleLease = outcome.kind === 'aborted' && !outcome.settled;
    const f = decideAfterFailure({
      retry: automaticRetry(def),
      emit: !!def.emit,
      attempt: run.Attempt,
      maxAttempts: run.MaxAttempts,
      error: raw,
      abortReason,
    });

    if (f.status === 'retrying') {
      return {
        status: 'retrying',
        reason: abortReason ?? null,
        error,
        countsAsFailure: false,
        keepScheduleLease,
        nextAttemptAt: now + f.delayMs,
      };
    }
    return {
      status: f.status,
      reason: abortReason ?? null,
      error,
      countsAsFailure: f.countsAsFailure,
      keepScheduleLease,
      nextAttemptAt: null,
    };
  }

  /**
   * A cancel the heartbeat has not delivered yet (the task failed first) still wins over the failure,
   * so a cancelled run is never retried.
   */
  protected async withCancelFromRow(run: RunModel, outcome: ExecutionOutcome): Promise<ExecutionOutcome> {
    if (outcome.kind === 'ok' || (outcome.kind === 'aborted' && outcome.reason === 'cancelled')) return outcome;
    const row = await RunModel.where('Id', run.Id).first();
    return row?.CancelRequested ? { kind: 'aborted', reason: 'cancelled', settled: true } : outcome;
  }

  protected async complete(
    run: RunModel,
    def: ScheduleDefinition,
    ctx: RunContext,
    outcome: ExecutionOutcome,
  ): Promise<void> {
    const now = this.Clock.now();

    if (outcome.kind === 'aborted' && outcome.reason === 'lease-lost') {
      this.Log.warn(`run ${run.Id} of ${run.Schedule} lost its lease; another replica owns the row now`);
      return;
    }

    outcome = await this.withCancelFromRow(run, outcome);
    const d = this.decide(run, def, outcome, now, ctx.stepOf(outcome));
    const explicit = ctx.explicitResult;
    const result = outcome.kind === 'ok' ? safeJson(explicit.set ? explicit.value : outcome.value) : undefined;
    const snap = ctx.snapshot();
    const finishedAt = d.status === 'retrying' ? null : now;

    const finished = await this.Leases.finishRun(
      run.Id,
      run.Attempt,
      defined({
        Status: d.status,
        Reason: d.reason,
        UpdatedAt: now,
        FinishedAt: finishedAt,
        NextAttemptAt: d.nextAttemptAt,
        Progress: d.status === 'succeeded' ? 100 : snap.Progress,
        Message: snap.Message,
        CurrentStep: null,
        Result: result,
        Error: jsonColumn(d.error),
        LeaseOwner: null,
        LeaseUntil: null,
      }),
    );
    if (!finished) {
      this.Log.warn(`run ${run.Id} could not be finished: the lease is gone`);
      return;
    }

    await RunAttemptModel.update({
      FinishedAt: now,
      Status: d.status === 'retrying' ? 'failed' : d.status,
      Error: jsonColumn(d.error) as never,
    })
      .where('RunId', run.Id)
      .where('Attempt', run.Attempt);
    if (d.error) await this.Events.write(run, run.Attempt, { type: 'error', error: d.error });
    await this.Events.write(run, run.Attempt, { type: 'status', status: d.status, reason: d.reason });
    if (!run.Forced && !d.keepScheduleLease) await this.Leases.releaseScheduleLease(run.Schedule, now);

    Object.assign(run, {
      Status: d.status,
      Reason: d.reason,
      FinishedAt: finishedAt,
      NextAttemptAt: d.nextAttemptAt,
      Error: d.error,
    });
    await this.Finalizer.finalized({
      run,
      def,
      status: d.status,
      error: d.error,
      now,
      countsAsFailure: d.countsAsFailure,
      nextAttemptAt: d.nextAttemptAt,
    });
  }
}
