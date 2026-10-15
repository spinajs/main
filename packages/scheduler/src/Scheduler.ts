import { v4 as uuidv4 } from 'uuid';
import { AsyncService, Autoinject, DI, IInstanceCheck, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import type { IWhereBuilder } from '@spinajs/orm';
import type { AbortReason, RunStatus, RunTrigger } from './contract.js';
import { RunAbortedError } from './errors.js';
import type { ScheduleDefinition, SchedulerConfig } from './interfaces.js';
import { jsonColumn } from './models/converters.js';
import { RunAttemptModel } from './models/RunAttemptModel.js';
import { RunModel } from './models/RunModel.js';
import { ScheduleModel } from './models/ScheduleModel.js';
import { OccurrencePlan, planOccurrence } from './policy/misfire.js';
import { automaticRetry, decideAfterFailure } from './policy/retry.js';
import { ScheduleRegistry } from './registry/ScheduleRegistry.js';
import { ExecutionHandle, RunExecutor } from './run/RunExecutor.js';
import { RunEventWriter } from './run/RunEventWriter.js';
import { RunFinalizer } from './run/RunFinalizer.js';
import { DefinitionSync } from './store/DefinitionSync.js';
import { LeaseStore, OccurrenceInput, RunExpiry } from './store/LeaseStore.js';
import { defaultReplicaId } from './store/replica.js';
import { Clock, DbClock, TimerHandle } from './time/clock.js';
import { fireTime } from './time/occurrences.js';
import { nextOccurrence } from './time/spec.js';
import { toStructuredError } from './tracking/structured.js';

export interface SchedulerInstanceOptions {
  replicaId?: string;
  autoStart?: boolean;
}

interface NewRun {
  status: RunStatus;
  trigger: RunTrigger;
  scheduledAt: number | null;
  now: number;
  owned: boolean;
  forced?: boolean;
  reason?: string | null;
  message?: string | null;
  finished?: boolean;
}

const INSTANCES = new Set<Scheduler>();

const missedCount = (plan: OccurrencePlan) => (plan.skippedCapped ? `more than ${plan.skipped}` : String(plan.skipped));

/** Schedulers resolved in this process and not stopped; the service wakes them and aborts local runs through them. */
export function activeSchedulers(): Scheduler[] {
  return [...INSTANCES];
}

/**
 * The loop of one replica. Every tick reads database time once and uses it for every ownership
 * decision of that tick. One instance per replica id (several in one process in tests).
 */
@PerInstanceCheck()
@Injectable()
export class Scheduler extends AsyncService implements IInstanceCheck {
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

  @Autoinject(RunEventWriter)
  protected Events: RunEventWriter;

  @Autoinject(RunFinalizer)
  protected Finalizer: RunFinalizer;

  public readonly ReplicaId: string;
  public Leases: LeaseStore;
  protected Executor: RunExecutor;
  protected config: SchedulerConfig;
  protected active = new Map<string, ExecutionHandle>();
  /** Active runs that hold no schedule lease (`Forced`). */
  protected forced = new Set<string>();
  protected timer: TimerHandle | undefined;
  protected running = false;
  protected stopping = false;
  protected ticking: Promise<void> | undefined;
  /** Database time of the last tick. */
  protected lastTickAt: number | undefined;
  /** Next occurrence of each `runOn: 'all'` schedule on this replica. */
  protected localNext = new Map<string, number | null>();

  constructor(public readonly Options: SchedulerInstanceOptions = {}) {
    super();
    this.ReplicaId = Options.replicaId ?? defaultReplicaId();
  }

  public __checkInstance__(creationOptions: unknown[]): boolean {
    const other = (creationOptions?.[0] ?? {}) as SchedulerInstanceOptions;
    return (other.replicaId ?? defaultReplicaId()) === this.ReplicaId;
  }

  public async resolve(): Promise<void> {
    this.config = this.Registry.config;
    this.Leases = DI.resolve(LeaseStore, [this.ReplicaId]);
    this.Executor = DI.resolve(RunExecutor, [this.Leases]);
    const now = await this.Clock.sync();
    await this.Sync.sync(this.Registry.all(), now);
    INSTANCES.add(this);
    await super.resolve();
    if (this.config.enabled && this.Options.autoStart !== false) this.start();
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    INSTANCES.add(this);
    this.schedule(0);
  }

  public wake(): void {
    if (this.running && !this.stopping) this.schedule(0);
  }

  public tickOnce(): Promise<void> {
    this.ticking ??= this.doTick().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  public async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()].map((h) => h.done));
  }

  public abortLocal(runId: string, reason: AbortReason): boolean {
    const h = this.active.get(runId);
    if (!h) return false;
    h.abort(reason);
    return true;
  }

  public isRunningLocally(runId: string): boolean {
    return this.active.has(runId);
  }

  public async stop(): Promise<void> {
    if (this.stopping) return this.idle();
    this.stopping = true;
    this.running = false;
    if (this.timer !== undefined) {
      this.Timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.ticking?.catch(() => undefined);
    for (const h of this.active.values()) h.abort('shutdown');
    // each execution is bounded by shutdownGrace inside the executor
    await this.idle();
    INSTANCES.delete(this);
  }

  public async dispose(): Promise<void> {
    await this.stop();
  }

  protected schedule(delayMs: number): void {
    if (this.timer !== undefined) this.Timers.clearTimeout(this.timer);
    this.timer = this.Timers.setTimeout(() => {
      this.timer = undefined;
      void this.timerTick();
    }, delayMs);
  }

  protected async timerTick(): Promise<void> {
    await this.tickOnce().catch((err) => this.Log.error(err as Error, 'scheduler tick failed'));
    const delay = await this.nextDelay().catch(() => this.config.tick);
    if (this.running && !this.stopping) this.schedule(delay);
  }

  /**
   * Time until the next instant after the last tick: a fire time (also of a local `runOn: 'all'`
   * occurrence), or a retry becoming claimable.
   * Instants the last tick already saw are not counted, so an item that is due but blocked (a
   * jitter window, a retry whose schedule lease another replica holds, a schedule this replica
   * does not know) is retried at the normal tick rate instead of in a tight loop.
   */
  protected async nextDelay(): Promise<number> {
    const tick = this.config.tick;
    const since = this.lastTickAt;
    if (since === undefined) return tick;
    const defs = this.Registry.all();
    const maxJitter = Math.max(0, ...defs.map((d) => d.jitterMs));
    const [rows, retry] = await Promise.all([
      ScheduleModel.where('Paused', false)
        .where('Orphaned', false)
        .whereNotNull('NextRunAt')
        .where('NextRunAt', '>', since - maxJitter)
        .where('NextRunAt', '<=', since + tick),
      RunModel.where('Status', 'retrying').where('NextAttemptAt', '>', since).orderBy('NextAttemptAt').first(),
    ]);
    const instants: number[] = [];
    for (const row of rows) {
      const def = this.Registry.find(row.Name);
      if (def && def.enabled && def.runOn === 'leader' && row.NextRunAt !== null)
        instants.push(fireTime(def, row.NextRunAt));
    }
    if (typeof retry?.NextAttemptAt === 'number') instants.push(retry.NextAttemptAt);
    for (const [name, due] of this.localNext) {
      const def = this.Registry.find(name);
      if (def && def.enabled && def.runOn === 'all' && due !== null) instants.push(fireTime(def, due));
    }
    const now = this.Clock.now();
    const until = instants.filter((t) => t > since).map((t) => t - now);
    return Math.max(0, Math.min(tick, ...until));
  }

  protected async doTick(): Promise<void> {
    if (this.stopping) return;
    const now = await this.Clock.sync();
    this.lastTickAt = now;
    await this.reapExpired(now);
    await this.fireDue(now);
    await this.claimQueued(now);
    await this.extraTickWork(now);
  }

  protected async extraTickWork(now: number): Promise<void> {
    await this.fireLocal(now);
  }

  /** `runOn: 'all'`: every replica fires from its own in-memory next occurrence, without the schedule lease. */
  protected async fireLocal(now: number): Promise<void> {
    const local = this.Registry.all().filter((d) => d.runOn === 'all' && d.enabled);
    if (local.length === 0) return;
    const halted = new Set(
      (
        await ScheduleModel.query().whereIn(
          'Name',
          local.map((d) => d.name),
        )
      )
        .filter((r) => r.Paused || r.Orphaned)
        .map((r) => r.Name),
    );

    for (const def of local) {
      if (this.stopping) return;
      if (!this.localNext.has(def.name)) this.localNext.set(def.name, nextOccurrence(def.spec, now));
      const due = this.localNext.get(def.name);
      if (due === null || due === undefined || now < fireTime(def, due)) continue;
      // local schedules never catch up: the next one is the first after now
      this.localNext.set(def.name, nextOccurrence(def.spec, Math.max(due, now)));
      // a paused occurrence is dropped, like a paused leader schedule's (S9 resume re-anchors on now)
      if (halted.has(def.name)) continue;

      if ([...this.active.values()].some((h) => h.schedule === def.name)) {
        await this.recordWithoutRunning(def, 'skipped', due, now, 'overlap', null);
        continue;
      }
      const run = await this.createRun(def, {
        status: 'running',
        trigger: 'schedule',
        scheduledAt: due,
        now,
        owned: true,
        forced: true,
      });
      this.launch(run, def);
    }
  }

  /**
   * A non-forced local run holds its schedule's lease. Once that lease expires (a stalled heartbeat),
   * the database lets this replica take it again, so only this check keeps a second run out.
   */
  protected holdsScheduleLocally(schedule: string): boolean {
    for (const h of this.active.values()) {
      if (h.schedule === schedule && !this.forced.has(h.runId)) return true;
    }
    return false;
  }

  /** Every path that claims a queued/retrying run for this process goes through this check first. */
  protected mayClaimLocally(run: RunModel): boolean {
    // e.g. reaped to `retrying` by another replica while the local executor is still in its grace period
    if (this.active.has(run.Id)) return false;
    return run.Forced || !this.holdsScheduleLocally(run.Schedule);
  }

  protected async fireDue(now: number): Promise<void> {
    const rows = await ScheduleModel.where('Paused', false)
      .where('Orphaned', false)
      .whereNotNull('NextRunAt')
      .where('NextRunAt', '<=', now);
    for (const row of rows) {
      if (this.stopping) return;
      const def = this.Registry.find(row.Name);
      if (!def || !def.enabled || def.runOn !== 'leader' || row.NextRunAt === null) continue;
      if (now < fireTime(def, row.NextRunAt)) continue;
      await this.fireOccurrence(def, row.NextRunAt, now);
    }
  }

  protected planFor(def: ScheduleDefinition, expected: number, now: number): OccurrencePlan {
    return planOccurrence(def, expected, now);
  }

  protected async fireOccurrence(def: ScheduleDefinition, expected: number, now: number): Promise<void> {
    const plan = this.planFor(def, expected, now);
    const input: OccurrenceInput = { name: def.name, expectedNextRunAt: expected, nextRunAt: plan.next, now };

    if (plan.kind === 'run' && !this.holdsScheduleLocally(def.name) && (await this.Leases.tryClaimOccurrence(input))) {
      const message = plan.skipped ? `caught up; ${missedCount(plan)} earlier occurrence(s) were not run` : null;
      const run = await this.createRun(def, {
        status: 'running',
        trigger: plan.trigger,
        scheduledAt: plan.scheduledAt,
        now,
        owned: true,
        message,
      });
      this.launch(run, def);
      return;
    }

    await this.onNotClaimed(def, plan, input);
  }

  protected async onNotClaimed(def: ScheduleDefinition, plan: OccurrencePlan, input: OccurrenceInput): Promise<void> {
    // a catch-up occurrence waits for the lease instead of being skipped
    if (plan.kind === 'run' && plan.trigger === 'catch-up') return;
    // the replica that advances NextRunAt owns the decision for this occurrence
    if (!(await this.Leases.advanceOccurrence(input))) return;

    if (plan.kind === 'misfire') {
      const message = `missed ${missedCount(plan)} occurrence(s)`;
      await this.recordWithoutRunning(def, 'misfired', plan.scheduledAt, input.now, 'misfire', message);
      return;
    }

    const running = await this.runningRunId(def.name);
    if (def.overlap === 'queue' && !(await this.hasQueued(def.name))) {
      const run = await this.createRun(def, {
        status: 'queued',
        trigger: plan.trigger,
        scheduledAt: plan.scheduledAt,
        now: input.now,
        owned: false,
        reason: 'overlap',
        message: running ? `queued behind run ${running}` : null,
      });
      await this.Events.write(run, 1, { type: 'status', status: 'queued', reason: 'overlap' });
      return;
    }

    await this.recordWithoutRunning(def, 'skipped', plan.scheduledAt, input.now, 'overlap', running);
  }

  protected async hasQueued(schedule: string): Promise<boolean> {
    return Number(await RunModel.count((b) => b.where('Schedule', schedule).where('Status', 'queued'))) > 0;
  }

  protected async runningRunId(schedule: string): Promise<string | null> {
    const r = await RunModel.where('Schedule', schedule)
      .where('Status', 'running')
      .orderByDescending('StartedAt')
      .first();
    return r?.Id ?? null;
  }

  protected async recordWithoutRunning(
    def: ScheduleDefinition,
    status: 'skipped' | 'misfired',
    scheduledAt: number,
    now: number,
    reason: string,
    detail: string | null,
  ): Promise<void> {
    const message = status === 'skipped' && detail ? `run ${detail} was still in progress` : detail;
    const run = await this.createRun(def, {
      status,
      trigger: 'schedule',
      scheduledAt,
      now,
      owned: false,
      reason,
      message,
      finished: true,
    });
    await this.Events.write(run, 1, { type: 'status', status, reason });
    await this.Finalizer.finalized({ run, def, status, error: null, now, countsAsFailure: false });
  }

  protected createRun(def: ScheduleDefinition, o: NewRun): Promise<RunModel> {
    return RunModel.create({
      Id: uuidv4(),
      Schedule: def.name,
      Trigger: o.trigger,
      TriggeredBy: null,
      ParentRunId: null,
      Params: null,
      Status: o.status,
      Reason: o.reason ?? null,
      Attempt: 1,
      MaxAttempts: automaticRetry(def)?.attempts ?? 1,
      NextAttemptAt: null,
      ScheduledAt: o.scheduledAt,
      CreatedAt: o.now,
      StartedAt: o.owned ? o.now : null,
      FinishedAt: o.finished ? o.now : null,
      UpdatedAt: o.now,
      Progress: 0,
      CurrentStep: null,
      Message: o.message ?? null,
      JobId: null,
      LeaseOwner: o.owned ? this.Leases.ReplicaId : null,
      LeaseUntil: o.owned ? o.now + this.Leases.LeaseTtl : null,
      CancelRequested: false,
      Forced: o.forced ?? false,
      ResumeFrom: null,
    });
  }

  protected async claimQueued(now: number): Promise<void> {
    const due = await RunModel.query()
      .whereIn('Status', ['queued', 'retrying'])
      .where(function (this: IWhereBuilder<unknown>) {
        this.whereNull('NextAttemptAt').orWhere('NextAttemptAt', '<=', now);
      })
      .orderBy('CreatedAt')
      .take(50);

    // oldest first, one claim attempt per schedule per tick keeps queued runs in order
    const tried = new Set<string>();
    for (const run of due) {
      if (this.stopping) return;
      if (!run.Forced) {
        if (tried.has(run.Schedule)) continue;
        tried.add(run.Schedule);
      }
      if (!this.mayClaimLocally(run)) continue;
      const def = this.Registry.find(run.Schedule);
      if (!def) continue;
      if (await this.Leases.claimRun(run, now)) this.launch(run, def);
    }
  }

  protected expiryDecision(
    run: RunModel,
    def: ScheduleDefinition | undefined,
    now: number,
  ): RunExpiry & { countsAsFailure: boolean } {
    const f = decideAfterFailure({
      retry: automaticRetry(def),
      emit: !!def?.emit,
      attempt: run.Attempt,
      maxAttempts: run.MaxAttempts,
      error: new RunAbortedError('lease-expired'),
      abortReason: 'lease-expired',
    });
    if (f.status === 'retrying') {
      return { status: 'retrying', reason: 'lease-expired', nextAttemptAt: now + f.delayMs, countsAsFailure: false };
    }
    return { status: f.status, reason: 'lease-expired', nextAttemptAt: null, countsAsFailure: f.countsAsFailure };
  }

  protected async reapExpired(now: number): Promise<void> {
    const expired = await RunModel.where('Status', 'running').where('LeaseUntil', '<', now).take(50);
    for (const run of expired) {
      // a local run with a stalled heartbeat aborts itself once its heartbeat reports the lease lost
      if (this.active.has(run.Id)) continue;
      const def = this.Registry.find(run.Schedule);
      const next = this.expiryDecision(run, def, now);
      if (!(await this.Leases.expireRun(run, now, next))) continue;

      const error = toStructuredError(new RunAbortedError('lease-expired'), { attempt: run.Attempt, occurredAt: now });
      await RunAttemptModel.update({
        FinishedAt: now,
        Status: next.status === 'retrying' ? 'failed' : next.status,
        Error: jsonColumn(error) as never,
      })
        .where('RunId', run.Id)
        .where('Attempt', run.Attempt);
      await this.Events.write(run, run.Attempt, { type: 'error', error });
      await this.Events.write(run, run.Attempt, { type: 'status', status: next.status, reason: next.reason });
      Object.assign(run, { Status: next.status, Reason: next.reason, NextAttemptAt: next.nextAttemptAt });
      await this.Finalizer.finalized({
        run,
        def,
        status: next.status,
        error,
        now,
        countsAsFailure: next.countsAsFailure,
        nextAttemptAt: next.nextAttemptAt,
      });
    }
  }

  protected launch(run: RunModel, def: ScheduleDefinition): void {
    const handle = this.Executor.start(run, def);
    this.active.set(run.Id, handle);
    if (run.Forced) this.forced.add(run.Id);
    void handle.done.finally(() => {
      if (this.active.get(run.Id) === handle) {
        this.active.delete(run.Id);
        this.forced.delete(run.Id);
      }
      this.wake();
    });
  }
}
