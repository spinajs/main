import { v4 as uuidv4 } from 'uuid';
import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import type { IWhereBuilder } from '@spinajs/orm';
import { DataValidator } from '@spinajs/validation';
import {
  ActionContext,
  ErrorFilter,
  ErrorGroupInfo,
  ErrorGroupNotFound,
  ErrorGroupStatus,
  InvalidRunParams,
  InvalidRunState,
  isTerminalStatus,
  Page,
  PauseOptions,
  PruneResult,
  RETRYABLE_RUN_STATUSES,
  RetryOptions,
  RunConflict,
  RunDetail,
  RunEventListener,
  RunFilter,
  RunInfo,
  RunNotFound,
  RunNowOptions,
  RunNowResult,
  RunTrigger,
  ScheduleDetail,
  ScheduleInfo,
  ScheduleNotFound,
  SchedulePaused,
  SchedulerService,
  SubscribeOptions,
  SubscribeTarget,
  TriggeredBy,
  Unsubscribe,
} from '../contract.js';
import { defined } from '../models/converters.js';
import { ErrorGroupModel } from '../models/ErrorGroupModel.js';
import { RunAttemptModel } from '../models/RunAttemptModel.js';
import { RunLogModel } from '../models/RunLogModel.js';
import { RunModel } from '../models/RunModel.js';
import { RunStepModel } from '../models/RunStepModel.js';
import { ScheduleModel } from '../models/ScheduleModel.js';
import type { ScheduleDefinition } from '../interfaces.js';
import { automaticRetry } from '../policy/retry.js';
import { ScheduleRegistry } from '../registry/ScheduleRegistry.js';
import { RetentionService } from '../retention/RetentionService.js';
import { toRunEvent } from '../run/events.js';
import { RunEventHub } from '../run/RunEventHub.js';
import { RunEventWriter } from '../run/RunEventWriter.js';
import { RunFinalizer } from '../run/RunFinalizer.js';
import { activeSchedulers } from '../Scheduler.js';
import { SchedulerSignals } from '../signals.js';
import { DefinitionSync } from '../store/DefinitionSync.js';
import { Clock, DbClock, TimerHandle } from '../time/clock.js';
import { fireTime } from '../time/occurrences.js';
import { nextOccurrence } from '../time/spec.js';
import {
  toArray,
  toAttemptInfo,
  toErrorGroupInfo,
  toMs,
  toParamErrors,
  toRunInfo,
  toScheduleInfo,
  toStepInfo,
} from './mappers.js';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 500;
const RECENT_RUNS = 20;
const DETAIL_LOGS = 200;
const CANCEL_ROUNDS = 3;
/** Ids per `IN (...)` list. */
const ID_BATCH = 500;
const ERROR_GROUP_STATUSES: readonly ErrorGroupStatus[] = ['open', 'resolved', 'ignored'];

export interface NewManualRun {
  trigger: RunTrigger;
  triggeredBy: TriggeredBy;
  params: Record<string, unknown> | null;
  now: number;
  forced: boolean;
  /** Claim order of queued runs; defaults to `now`. */
  createdAt?: number;
  parentRunId?: string;
  attempt?: number;
  resumeFrom?: { runId: string; fromStep?: string } | null;
  checkpoint?: unknown;
}

const intOr = (v: number | undefined, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;

/**
 * The single façade over schedules and runs; the CLI and `@spinajs/scheduler-http` call only this.
 * Expected failures are thrown as the contract's error classes, which `httpStatusForError` /
 * `exitCodeForError` map; anything else is an internal error.
 */
@Singleton()
@Injectable(SchedulerService)
export class DefaultSchedulerService extends SchedulerService {
  @Logger('SCHEDULER')
  protected Log: Log;

  @Autoinject(ScheduleRegistry)
  protected Registry: ScheduleRegistry;

  @Autoinject(DefinitionSync)
  protected Sync: DefinitionSync;

  @Autoinject(DbClock)
  protected Clock: DbClock;

  @Autoinject(Clock)
  protected Timers: Clock;

  @Autoinject(RunEventHub)
  protected Hub: RunEventHub;

  @Autoinject(RunEventWriter)
  protected Events: RunEventWriter;

  @Autoinject(RunFinalizer)
  protected Finalizer: RunFinalizer;

  @Autoinject(DataValidator)
  protected Validator: DataValidator;

  @Autoinject(SchedulerSignals)
  protected Signals: SchedulerSignals;

  @Autoinject(RetentionService)
  protected Retention: RetentionService;

  /** A process that never starts the loop (CLI, API-only replica) still sees every schedule. */
  public async resolve(): Promise<void> {
    await this.Sync.sync(this.Registry.all(), await this.Clock.sync());
    await super.resolve();
  }

  public async listSchedules(): Promise<ScheduleInfo[]> {
    const now = await this.now();
    const rows = await ScheduleModel.query().orderBy('Name');
    const lastIds = rows.map((r) => r.LastRunId).filter((id): id is string => !!id);
    const last = lastIds.length ? await RunModel.query().whereIn('Id', lastIds) : [];
    const running = await RunModel.where('Status', 'running');
    return rows.map((row) =>
      toScheduleInfo(
        row,
        this.Registry.find(row.Name),
        running.find((r) => r.Schedule === row.Name) ?? last.find((r) => r.Id === row.LastRunId) ?? null,
        now,
      ),
    );
  }

  public async getSchedule(name: string): Promise<ScheduleDetail> {
    const now = await this.now();
    const row = await this.loadScheduleRow(name);
    const recent = await this.listRuns({ schedule: name, limit: RECENT_RUNS });
    const openErrors = await this.listErrors({ schedule: name, status: 'open' });
    return {
      ...toScheduleInfo(row, this.Registry.find(name), await this.lastRunOf(row), now),
      definition: row.Definition ?? {},
      recentRuns: recent.items,
      openErrors,
    };
  }

  public async listRuns(filter: RunFilter = {}): Promise<Page<RunInfo>> {
    const now = await this.now();
    const limit = Math.min(Math.max(intOr(filter.limit, DEFAULT_PAGE), 1), MAX_PAGE);
    const offset = Math.max(intOr(filter.offset, 0), 0);
    const from = filter.from !== undefined ? toMs(filter.from) : undefined;
    const to = filter.to !== undefined ? toMs(filter.to) : undefined;
    const apply = <B extends IWhereBuilder<unknown>>(q: B): B => {
      if (filter.schedule) q.where('Schedule', filter.schedule);
      if (filter.status) q.whereIn('Status', toArray(filter.status));
      if (filter.trigger) q.whereIn('Trigger', toArray(filter.trigger));
      if (from !== undefined) q.where('CreatedAt', '>=', from);
      if (to !== undefined) q.where('CreatedAt', '<=', to);
      return q;
    };
    // Postgres returns COUNT(*) as an int8 string
    const total = Number(await RunModel.count((b) => void apply(b as IWhereBuilder<unknown>)));
    const rows = await apply(RunModel.query()).orderByDescending('CreatedAt').skip(offset).take(limit);
    return { items: rows.map((r) => this.info(r, now)), total, limit, offset };
  }

  public async getRun(id: string): Promise<RunDetail> {
    const now = await this.now();
    const run = await this.loadRun(id);
    const attempts = await RunAttemptModel.where('RunId', id).orderBy('Attempt');
    const steps = await RunStepModel.where('RunId', id).orderBy('Id');
    const logs = await RunLogModel.where('RunId', id)
      .whereIn('Kind', ['log', 'message', 'error'])
      .orderByDescending('Seq')
      .take(DETAIL_LOGS);
    return {
      ...this.info(run, now),
      attempts: attempts.map(toAttemptInfo),
      steps: steps.map(toStepInfo),
      logs: logs.reverse().map(toRunEvent),
      checkpoint: run.Checkpoint ?? null,
    };
  }

  /** Synthetic `progress` events (R16) are passed through as the hub delivers them. */
  public async subscribe(
    target: SubscribeTarget,
    listener: RunEventListener,
    options?: SubscribeOptions,
  ): Promise<Unsubscribe> {
    if ('runId' in target) await this.loadRun(target.runId);
    else if (!this.Registry.find(target.schedule)) await this.loadScheduleRow(target.schedule);
    return this.Hub.subscribe(target, listener, options);
  }

  public async listErrors(filter: ErrorFilter = {}): Promise<ErrorGroupInfo[]> {
    let q = ErrorGroupModel.query();
    if (filter.schedule) q = q.where('Schedule', filter.schedule);
    if (filter.status) q = q.whereIn('Status', toArray(filter.status));
    return (await q.orderByDescending('LastSeen')).map(toErrorGroupInfo);
  }

  /**
   * A `runOn: 'all'` schedule may be run manually too: the run is `Forced` (no schedule lease) and
   * executes once, on the first replica that claims it while not running that schedule itself. Local
   * occurrences on replicas are per-replica work, so there only a queued manual run is a conflict.
   */
  public async runNow(name: string, o: RunNowOptions): Promise<RunNowResult> {
    const def = this.Registry.get(name);
    const params = this.validateParams(def, o.params);
    const now = await this.now();
    await this.assertManualRunsAllowed(name);

    const busy = await this.busyRunId(def, now);
    if (busy && !o.force) throw new RunConflict(`schedule '${name}' already has run ${busy} in progress`, busy);

    const forced = def.runOn === 'all' || (!!busy && def.overlap === 'skip');
    const run = await this.createQueuedRun(def, { trigger: 'manual', triggeredBy: o.triggeredBy, params, now, forced });
    this.audit('run', o.triggeredBy, { schedule: name, runId: run.Id, force: !!o.force, params });
    this.wakeLocal();

    if (!o.wait) return { runId: run.Id };
    const timeoutMs = typeof o.wait === 'object' ? o.wait.timeoutMs : undefined;
    return { runId: run.Id, run: await this.waitForEnd(run.Id, timeoutMs) };
  }

  /**
   * A `queued` or `retrying` run ends `aborted` / `cancelled` at once. A `running` run is flagged, and
   * its holder aborts it on its next heartbeat (at once when it runs in this process).
   */
  public async cancel(runId: string, ctx: ActionContext): Promise<RunInfo> {
    // every write is conditional on the state just read; a run that moved on meanwhile is looked at again
    for (let round = 0; round < CANCEL_ROUNDS; round++) {
      const run = await this.loadRun(runId);
      const now = await this.now();
      if (run.Status === 'queued' || run.Status === 'retrying') {
        if (!(await this.abortWaitingRun(run, now))) continue;
      } else if (run.Status === 'running') {
        const r = await RunModel.update({ CancelRequested: true }).where('Id', runId).where('Status', 'running');
        if (r.RowsAffected !== 1) continue;
        for (const s of activeSchedulers()) s.abortLocal(runId, 'cancelled');
      } else {
        throw new InvalidRunState(
          `run ${runId} is ${run.Status}; only queued, retrying or running runs can be cancelled`,
          run.Status,
        );
      }
      this.audit('cancel', ctx.triggeredBy, { runId, schedule: run.Schedule, status: run.Status });
      return this.info(await this.loadRun(runId), now);
    }
    const current = await this.loadRun(runId);
    throw new InvalidRunState(`run ${runId} kept changing state (now ${current.Status}); try again`, current.Status);
  }

  /**
   * A new linked run (`trigger: retry`, attempt `parent + 1`). `fromStep` implies resume; `resume`
   * defaults to the schedule's `resumable`. A resumed retry skips the parent's completed steps and
   * starts from its last checkpoint.
   */
  public async retry(runId: string, o: RetryOptions): Promise<RunNowResult> {
    const plan = await this.planRetry(await this.loadRun(runId), o);
    const run = await this.createQueuedRun(plan.def, { ...plan.run, now: await this.now() });
    this.auditRetry(run, o);
    this.wakeLocal();
    return { runId: run.Id };
  }

  /** One retry per `failed` / `dead` run finished at or after `since` that has none yet, oldest first. */
  public async retryFailed(name: string, since: Date | string, ctx: ActionContext): Promise<{ runIds: string[] }> {
    this.Registry.get(name);
    const sinceMs = toMs(since);
    await this.assertManualRunsAllowed(name);
    const failed = await RunModel.query()
      .where('Schedule', name)
      .whereIn('Status', ['failed', 'dead'])
      .where('FinishedAt', '>=', sinceMs)
      .orderBy('FinishedAt');
    if (!failed.length) return { runIds: [] };

    const retried = new Set<string>();
    for (let i = 0; i < failed.length; i += ID_BATCH) {
      const ids = failed.slice(i, i + ID_BATCH).map((f) => f.Id);
      for (const child of await RunModel.query().whereIn('ParentRunId', ids)) retried.add(child.ParentRunId!);
    }

    const o: RetryOptions = { triggeredBy: ctx.triggeredBy };
    // every retry is validated before the first one is created
    const plans = [];
    for (const f of failed) if (!retried.has(f.Id)) plans.push(await this.planRetry(f, o));

    const now = await this.now();
    const runIds: string[] = [];
    for (const [i, plan] of plans.entries()) {
      // queued runs are claimed by CreatedAt; equal values would leave the order to the database
      const run = await this.createQueuedRun(plan.def, { ...plan.run, now, createdAt: now + i });
      this.auditRetry(run, o);
      runIds.push(run.Id);
    }
    if (runIds.length) this.wakeLocal();
    return { runIds };
  }

  /** Stops scheduled runs; manual runs and retries go on unless `hard`. Replaces a pause by failures. */
  public async pause(name: string, o: PauseOptions): Promise<ScheduleInfo> {
    await this.loadScheduleRow(name);
    const now = await this.now();
    await ScheduleModel.update({ Paused: true, PausedReason: 'manual', HardPaused: !!o.hard, UpdatedAt: now }).where(
      'Name',
      name,
    );
    this.audit('pause', o.triggeredBy, { schedule: name, hard: !!o.hard });
    return this.scheduleInfo(name, now);
  }

  /**
   * Clears a manual pause or a pause by failures and resets the failure count. A `NextRunAt` whose fire
   * time passed during the pause moves to the first occurrence after now, so a long pause fires
   * nothing late; one still ahead is kept.
   */
  public async resume(name: string, ctx: ActionContext): Promise<ScheduleInfo> {
    const row = await this.loadScheduleRow(name);
    const now = await this.now();
    const def = this.Registry.find(name);
    const missed =
      !!def && def.enabled && def.runOn === 'leader' && row.NextRunAt !== null && fireTime(def, row.NextRunAt) <= now;

    // nothing claims or advances a paused schedule's occurrence, so NextRunAt read above is current
    const resumed =
      row.Paused &&
      (
        await ScheduleModel.update(
          defined({
            Paused: false,
            PausedReason: null,
            HardPaused: false,
            ConsecutiveFailures: 0,
            NextRunAt: missed ? nextOccurrence(def.spec, now) : undefined,
            UpdatedAt: now,
          }),
        )
          .where('Name', name)
          .where('Paused', true)
      ).RowsAffected === 1;
    if (!resumed) {
      await ScheduleModel.update({ HardPaused: false, ConsecutiveFailures: 0, UpdatedAt: now }).where('Name', name);
    }

    try {
      await this.Signals.healthChanged(name, 0);
    } catch (err) {
      this.Log.warn(err as Error, `could not signal the health of ${name}`);
    }
    this.audit('resume', ctx.triggeredBy, { schedule: name });
    return this.scheduleInfo(name, now);
  }

  public async setErrorStatus(
    fingerprint: string,
    status: ErrorGroupStatus,
    ctx: ActionContext,
  ): Promise<ErrorGroupInfo> {
    if (!ERROR_GROUP_STATUSES.includes(status)) {
      throw new InvalidRunParams(`unknown error status '${String(status)}'`, [
        { path: '/status', message: `must be one of ${ERROR_GROUP_STATUSES.join(', ')}` },
      ]);
    }
    const group = await ErrorGroupModel.where('Fingerprint', fingerprint).first();
    if (!group) throw new ErrorGroupNotFound(fingerprint);
    await ErrorGroupModel.update({ Status: status }).where('Id', group.Id);
    this.audit('error-status', ctx.triggeredBy, { fingerprint, status, schedule: group.Schedule });
    return toErrorGroupInfo(await ErrorGroupModel.where('Id', group.Id).first());
  }

  /** Deletes orphaned schedule rows, then everything past retention (`RetentionService.purge`). */
  public async prune(ctx: ActionContext): Promise<PruneResult> {
    const now = await this.now();
    let orphanedSchedules = 0;
    for (const o of await ScheduleModel.where('Orphaned', true)) {
      // conditional: a replica that defines it again may have revived it meanwhile
      const r = await ScheduleModel.destroy(o.Name).where('Orphaned', true);
      orphanedSchedules += Number(r.RowsAffected);
    }
    const result = { orphanedSchedules, ...(await this.Retention.purge(now)) };
    this.audit('prune', ctx.triggeredBy, { ...result });
    return result;
  }

  /** `false` when the run was claimed or changed after `run` was read. */
  protected async abortWaitingRun(run: RunModel, now: number): Promise<boolean> {
    const r = await RunModel.update({
      Status: 'aborted',
      Reason: 'cancelled',
      CancelRequested: true,
      FinishedAt: now,
      UpdatedAt: now,
      NextAttemptAt: null,
    })
      .where('Id', run.Id)
      .where('Status', run.Status)
      .where('Attempt', run.Attempt);
    if (r.RowsAffected !== 1) return false;

    // the finalizer decides error grouping and health from Reason
    Object.assign(run, {
      Status: 'aborted',
      Reason: 'cancelled',
      CancelRequested: true,
      FinishedAt: now,
      NextAttemptAt: null,
    });
    await this.Events.write(run, run.Attempt, { type: 'status', status: 'aborted', reason: 'cancelled' });
    await this.Finalizer.finalized({
      run,
      def: this.Registry.find(run.Schedule),
      status: 'aborted',
      error: null,
      now,
      countsAsFailure: false,
    });
    return true;
  }

  protected async planRetry(
    parent: RunModel,
    o: RetryOptions,
  ): Promise<{ def: ScheduleDefinition; run: Omit<NewManualRun, 'now'> }> {
    if (!RETRYABLE_RUN_STATUSES.includes(parent.Status)) {
      throw new InvalidRunState(
        `run ${parent.Id} is ${parent.Status}; only failed, dead or aborted runs can be retried`,
        parent.Status,
      );
    }
    const def = this.Registry.get(parent.Schedule);
    const params = this.validateParams(def, o.params ?? parent.Params);
    if (o.fromStep !== undefined && !(await RunStepModel.where('RunId', parent.Id).where('Name', o.fromStep).first())) {
      throw new InvalidRunParams(`run ${parent.Id} has no step '${o.fromStep}'`, [
        { path: '/fromStep', message: 'unknown step' },
      ]);
    }
    await this.assertManualRunsAllowed(def.name);

    const resume = o.fromStep !== undefined || (o.resume ?? def.resumable);
    return {
      def,
      run: {
        trigger: 'retry',
        triggeredBy: o.triggeredBy,
        params,
        forced: def.runOn === 'all',
        parentRunId: parent.Id,
        attempt: parent.Attempt + 1,
        resumeFrom: resume ? { runId: parent.Id, ...(o.fromStep !== undefined ? { fromStep: o.fromStep } : {}) } : null,
        checkpoint: resume ? parent.Checkpoint ?? null : null,
      },
    };
  }

  protected auditRetry(run: RunModel, o: RetryOptions): void {
    this.audit('retry', o.triggeredBy, {
      schedule: run.Schedule,
      runId: run.Id,
      parentRunId: run.ParentRunId,
      fromStep: o.fromStep ?? null,
      resume: !!run.ResumeFrom,
    });
  }

  protected async assertManualRunsAllowed(name: string): Promise<void> {
    if ((await this.loadScheduleRow(name)).HardPaused) throw new SchedulePaused(name);
  }

  /** The run a manual run would overlap: a queued run first, else a running one whose lease is live. */
  protected async busyRunId(def: ScheduleDefinition, now: number): Promise<string | null> {
    const queued = await RunModel.where('Schedule', def.name).where('Status', 'queued').orderBy('CreatedAt').first();
    if (queued) return queued.Id;
    if (def.runOn === 'all') return null;
    const running = await RunModel.where('Schedule', def.name)
      .where('Status', 'running')
      .where('LeaseUntil', '>', now)
      .orderByDescending('StartedAt')
      .first();
    return running?.Id ?? null;
  }

  /** Returns what to store: a validated copy with ajv's coercion and defaults applied. */
  protected validateParams(
    def: ScheduleDefinition,
    params?: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!def.paramsSchema) {
      if (params && Object.keys(params).length) {
        throw new InvalidRunParams(`schedule '${def.name}' takes no parameters`, [
          { path: '', message: 'no parameters are allowed' },
        ]);
      }
      return null;
    }
    // ajv coerces and fills defaults in place; never touch the caller's object
    const data = structuredClone(params ?? {});
    const [ok, errors] = this.Validator.tryValidate(def.paramsSchema, data);
    if (!ok) throw new InvalidRunParams(`invalid parameters for schedule '${def.name}'`, toParamErrors(errors ?? []));
    return data;
  }

  /**
   * `MaxAttempts` is the run's total attempt budget (R11). A manual retry starts at `parent + 1` and
   * still gets the schedule's whole automatic budget on top, also when the parent ran out of it (`dead`).
   */
  protected async createQueuedRun(def: ScheduleDefinition, o: NewManualRun): Promise<RunModel> {
    const attempt = o.attempt ?? 1;
    const run = await RunModel.create({
      Id: uuidv4(),
      Schedule: def.name,
      Trigger: o.trigger,
      TriggeredBy: o.triggeredBy,
      ParentRunId: o.parentRunId ?? null,
      Params: o.params,
      Status: 'queued',
      Reason: null,
      Attempt: attempt,
      MaxAttempts: attempt + (automaticRetry(def)?.attempts ?? 1) - 1,
      NextAttemptAt: null,
      ScheduledAt: o.now,
      CreatedAt: o.createdAt ?? o.now,
      UpdatedAt: o.now,
      Progress: 0,
      CancelRequested: false,
      Forced: o.forced,
      ResumeFrom: o.resumeFrom ?? null,
      Checkpoint: o.checkpoint ?? null,
    });
    await this.Events.write(run, attempt, { type: 'status', status: 'queued', reason: o.trigger });
    return run;
  }

  protected wakeLocal(): void {
    for (const s of activeSchedulers()) s.wake();
  }

  /** The run once it reached a terminal status, or as it is when `timeoutMs` passed (the run goes on). */
  protected async waitForEnd(runId: string, timeoutMs?: number): Promise<RunInfo> {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let timer: TimerHandle | undefined;
    const off = await this.Hub.subscribe({ runId }, (e) => {
      if (e.type === 'status' && isTerminalStatus(e.status)) finish();
    });
    try {
      if (timeoutMs !== undefined) timer = this.Timers.setTimeout(finish, timeoutMs);
      await finished;
    } finally {
      off();
      if (timer !== undefined) this.Timers.clearTimeout(timer);
    }
    return this.info(await this.loadRun(runId), await this.now());
  }

  protected now(): Promise<number> {
    return this.Clock.sync();
  }

  protected async loadRun(id: string): Promise<RunModel> {
    const run = await RunModel.where('Id', id).first();
    if (!run) throw new RunNotFound(id);
    return run;
  }

  protected async loadScheduleRow(name: string): Promise<ScheduleModel> {
    const row = await ScheduleModel.where('Name', name).first();
    if (!row) throw new ScheduleNotFound(name);
    return row;
  }

  /** A run in progress wins over the last finished one. */
  protected async lastRunOf(row: ScheduleModel): Promise<RunModel | null> {
    const running = await RunModel.where('Schedule', row.Name)
      .where('Status', 'running')
      .orderByDescending('StartedAt')
      .first();
    if (running) return running;
    return row.LastRunId ? (await RunModel.where('Id', row.LastRunId).first()) ?? null : null;
  }

  protected async scheduleInfo(name: string, now: number): Promise<ScheduleInfo> {
    const row = await this.loadScheduleRow(name);
    return toScheduleInfo(row, this.Registry.find(name), await this.lastRunOf(row), now);
  }

  protected info(run: RunModel, now: number): RunInfo {
    return toRunInfo(run, now, this.Registry.config.leaseTtl);
  }

  protected audit(action: string, by: TriggeredBy, details: Record<string, unknown>): void {
    this.Log.info(
      { audit: true, action, triggeredBy: by, ...details },
      `scheduler audit: ${action} by ${by.kind}:${by.id}`,
    );
  }
}
