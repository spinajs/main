import { v4 as uuidv4 } from 'uuid';
import { Autoinject, DI, Injectable, NewInstance, Singleton } from '@spinajs/di';
import { DbClock } from '@spinajs/durable';
import { isCrashError, RunAbortedError, ScheduleOverlap } from '../errors.js';
import type { AbortReason, RunStatus, TriggeredBy } from '../contract.js';
import type { ScheduleDefinition } from '../interfaces.js';
import { RunModel } from '../models/RunModel.js';
import { LeaseStore } from '../store/LeaseStore.js';
import { isStackingTaskMethod } from '../tasks/task-methods.js';
import { withRunContext } from './current.js';
import type { ExecutionOutcome } from './outcome.js';
import type { RunContext } from './RunContext.js';
import { RunExecutor } from './RunExecutor.js';

export interface InlineRunOptions {
  /** Recorded as `{ kind: 'service', id: triggeredBy }`; defaults to `{ kind: 'system', id: 'inline' }`. */
  triggeredBy?: string;
  /** Stored as the run's `Params` when it is a plain object. */
  params?: unknown;
}

export type InlineBody<T> = (ctx: RunContext) => Promise<T>;

/** How the run ended; `status` is `running` when this executor could not record the end (lease lost, crash). */
export interface InlineEnd {
  outcome: ExecutionOutcome;
  status: RunStatus;
  reason: string | null;
}

/** Executes the caller's function instead of the schedule's task. */
@NewInstance()
@Injectable()
export class InlineRunExecutor extends RunExecutor {
  protected bodies = new Map<string, InlineBody<unknown>>();
  protected ends = new Map<string, InlineEnd>();

  /** Unlike `start()`, a failure of the executor itself (a write it could not make) rejects. */
  public async runBody<T>(run: RunModel, def: ScheduleDefinition, body: InlineBody<T>): Promise<InlineEnd | undefined> {
    const ac = new AbortController();
    const abort = (reason: AbortReason) => {
      if (!ac.signal.aborted) ac.abort(reason);
    };
    this.bodies.set(run.Id, body);
    try {
      await this.execute(run, def, ac, abort);
      return this.ends.get(run.Id);
    } finally {
      this.bodies.delete(run.Id);
      this.ends.delete(run.Id);
    }
  }

  protected override invoke(def: ScheduleDefinition, ctx: RunContext): Promise<unknown> {
    const body = this.bodies.get(ctx.runId);
    if (!body) return super.invoke(def, ctx);
    return withRunContext(ctx, () => body(ctx));
  }

  protected override async complete(
    run: RunModel,
    def: ScheduleDefinition,
    ctx: RunContext,
    outcome: ExecutionOutcome,
  ): Promise<void> {
    await super.complete(run, def, ctx, outcome);
    this.ends.set(run.Id, { outcome, status: run.Status, reason: run.Reason });
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Runs a function now, in the caller's process, as a `manual` run of a schedule. The run row is inserted
 * already claimed by this replica, so no scheduler loop can pick it up and run the schedule's task instead.
 */
@Singleton()
@Injectable()
export class InlineRunner {
  @Autoinject(DbClock)
  protected Clock: DbClock;

  protected Leases = DI.resolve(LeaseStore);
  protected Executor: InlineRunExecutor | undefined;
  /** Inline runs of `runOn: 'all'` schedules in this process, which take no schedule lease. */
  protected local = new Set<string>();

  protected executor(): InlineRunExecutor {
    this.Executor ??= DI.resolve(InlineRunExecutor, [this.Leases]);
    return this.Executor;
  }

  public async run<T>(def: ScheduleDefinition, body: InlineBody<T>, opts: InlineRunOptions = {}): Promise<T> {
    // the caller sees the failure: an automatic retry would run the schedule's task, not this body
    const inlineDef: ScheduleDefinition = { ...def, retry: undefined, emit: undefined };
    const local = def.runOn === 'all' && !isStackingTaskMethod(def.task);
    if (local) this.enterLocal(def.name);
    try {
      const run = await this.claim(inlineDef, opts, local);
      let end: InlineEnd | undefined;
      try {
        end = await this.executor().runBody(run, inlineDef, body);
      } catch (err) {
        if (!run.Forced && !isCrashError(err)) {
          await this.Leases.releaseScheduleLease(def.name, this.Clock.now()).catch(() => false);
        }
        throw err;
      }
      return resultOf<T>(end);
    } finally {
      if (local) this.leaveLocal(def.name);
    }
  }

  /** Synchronous, so two calls in this process cannot both pass before either has a run row. */
  protected enterLocal(schedule: string): void {
    if (this.local.has(schedule)) throw new ScheduleOverlap(schedule, null);
    this.local.add(schedule);
  }

  protected leaveLocal(schedule: string): void {
    this.local.delete(schedule);
  }

  /** For the scheduler loop of the same replica, which must not start a `runOn: 'all'` run beside it. */
  public isRunningLocally(schedule: string, replicaId: string): boolean {
    return replicaId === this.Leases.ReplicaId && this.local.has(schedule);
  }

  /** `local`: a `runOn: 'all'` run, which must not overlap a run of the schedule this replica holds (as the loop's). */
  protected async claim(def: ScheduleDefinition, opts: InlineRunOptions, local: boolean): Promise<RunModel> {
    const now = await this.Clock.sync();
    // a @Task with taskStacking never waited for its own earlier calls
    const forced = local || isStackingTaskMethod(def.task);
    const lease = forced ? null : await this.Leases.takeScheduleLease(def.name, now);
    if (lease === false) throw new ScheduleOverlap(def.name, await this.runningRunId(def.name));
    if (local) {
      const mine = await this.heldRunId(def.name, now);
      if (mine) throw new ScheduleOverlap(def.name, mine);
    }

    try {
      return await RunModel.create({
        Id: uuidv4(),
        Schedule: def.name,
        Trigger: 'manual',
        TriggeredBy: triggeredBy(opts.triggeredBy),
        ParentRunId: null,
        Params: isRecord(opts.params) ? opts.params : null,
        Status: 'running',
        Reason: null,
        Attempt: 1,
        MaxAttempts: 1,
        NextAttemptAt: null,
        ScheduledAt: now,
        CreatedAt: now,
        StartedAt: now,
        UpdatedAt: now,
        Progress: 0,
        LeaseOwner: this.Leases.ReplicaId,
        LeaseUntil: now + this.Leases.LeaseTtl,
        CancelRequested: false,
        Forced: forced,
        ResumeFrom: null,
      });
    } catch (err) {
      if (lease === 'free' && !isCrashError(err)) await this.Leases.releaseScheduleLease(def.name, now);
      throw err;
    }
  }

  protected async heldRunId(schedule: string, now: number): Promise<string | null> {
    const r = await RunModel.where('Schedule', schedule)
      .where('Status', 'running')
      .where('LeaseOwner', this.Leases.ReplicaId)
      .where('LeaseUntil', '>', now)
      .first();
    return r?.Id ?? null;
  }

  protected async runningRunId(schedule: string): Promise<string | null> {
    const r = await RunModel.where('Schedule', schedule)
      .where('Status', 'running')
      .orderByDescending('StartedAt')
      .first();
    return r?.Id ?? null;
  }
}

function resultOf<T>(end: InlineEnd | undefined): T {
  const outcome = end?.outcome;
  if (outcome?.kind === 'error' && isCrashError(outcome.error)) throw outcome.error;
  if (end?.status === 'succeeded' && outcome?.kind === 'ok') return outcome.value as T;
  if (end?.status === 'failed' && outcome?.kind === 'error') throw outcome.error;
  // any other end was not recorded by this executor (lease lost) or ended the run early (cancel, timeout)
  throw new RunAbortedError(end?.status === 'aborted' ? (end.reason as AbortReason) : 'lease-lost');
}

function triggeredBy(id: string | undefined): TriggeredBy {
  return id === undefined ? { kind: 'system', id: 'inline' } : { kind: 'service', id };
}
