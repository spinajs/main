import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Config } from '@spinajs/configuration';
import { AsyncService, Autoinject, DI, Injectable, PerInstanceCheck, type IInstanceCheck } from '@spinajs/di';
import { Clock, DbClock, FaultInjector, Heartbeat, quoteFor, RowLease, sqlDialect } from '@spinajs/durable';
import { InvalidArgument } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';
import type { IWhereBuilder, OrmDriver } from '@spinajs/orm';
import { ActivationContext, type Park } from './context.js';
import type { SerializedError } from './contract.js';
import { isCrash, LeaseLostError, NonDeterminismError, serializeError, type AbortReason } from './errors.js';
import { missingVersions } from './health.js';
import { identifierProblem } from './identifier.js';
import { Journal } from './journal.js';
import { safeStringify } from './json.js';
import { WorkflowInstanceModel } from './models/WorkflowInstanceModel.js';
import { WorkflowRegistry, type RegisteredWorkflow } from './registry.js';
import { selectRows, workflowDriver } from './sql.js';
import { InstanceStore } from './store.js';
import { resolveWorkflowConfig, type WorkflowConfig } from './workflow-config.js';

export interface WorkflowEngineOptions {
  replicaId?: string;
}

type Outcome = { kind: 'ok'; value: unknown } | { kind: 'error'; error: unknown } | { kind: 'aborted' };
type Patch = Partial<WorkflowInstanceModel>;
/** `release`: no status write, only the fenced release (0 rows after a takeover, the row freed at once otherwise); `discard`: a dead replica writes and releases nothing. */
type Decision = { kind: 'write'; patch: Patch } | { kind: 'release' } | { kind: 'discard' };

interface Signals {
  run: AbortSignal;
  /** Outlives a cancel and the instance deadline, which must not cut a compensation pass short. */
  compensation: AbortSignal;
}

interface Activation {
  abort(reason: AbortReason): void;
  done: Promise<void>;
}

const MAX_REPLICA_ID = 64;
const DUE_STATUSES = ['running', 'sleeping', 'waiting', 'compensating'];
const PARKED = new Set(['running', 'sleeping', 'waiting']);
const INTERRUPTION_REASON = { fail: 'fail', timeout: 'timeout', nondeterminism: 'non-determinism' } as const;
const STOPS_COMPENSATION = new Set<AbortReason>(['lease-lost', 'crashed', 'journal-failed', 'shutdown']);
/** A run that no longer matches its journal cannot tell which steps it took; a failed pass is resumed by retry(). */
const UNCOMPENSATED = new Set<string>([INTERRUPTION_REASON.nondeterminism, 'compensation-failed']);

let processReplicaId: string | undefined;

/** Fits `ClaimedBy` (64 characters): the host name is cut to 40. */
export function defaultReplicaId(): string {
  processReplicaId ??= `${hostname().trim().slice(0, 40)}:${process.pid}:${randomBytes(3).toString('hex')}`;
  return processReplicaId;
}

function leaseFree(now: number) {
  return function (this: IWhereBuilder<unknown>) {
    this.whereNull('ClaimedBy').orWhere('ClaimedUntil', '<', now);
  };
}

function registeredVersions(defs: RegisteredWorkflow[]) {
  return function (this: IWhereBuilder<unknown>) {
    defs.forEach((d, i) => {
      const pair = function (this: IWhereBuilder<unknown>) {
        this.where('Workflow', d.name).where('Version', d.version);
      };
      if (i === 0) this.where(pair);
      else this.orWhere(pair);
    });
  };
}

/** Semantic 1: running or compensating with no wake time, or any of the due statuses whose wake time has come. */
function dueNow(now: number) {
  return function (this: IWhereBuilder<unknown>) {
    this.where(function (this: IWhereBuilder<unknown>) {
      this.whereIn('Status', ['running', 'compensating']).whereNull('WakeAt');
    }).orWhere('WakeAt', '<=', now);
  };
}

/**
 * One replica's loop body. `tick()` claims due instances with a fenced row lease and runs their
 * activations to the end before it resolves; when the next tick happens is the driver's business
 * (`WorkflowWorker`, or the simulation harness).
 */
@PerInstanceCheck()
@Injectable()
export class WorkflowEngine extends AsyncService implements IInstanceCheck {
  @Logger('WORKFLOW')
  protected Log: Log;

  @Autoinject(WorkflowRegistry)
  protected Registry: WorkflowRegistry;

  @Autoinject(DbClock)
  protected Clock: DbClock;

  @Autoinject(Clock)
  protected Timers: Clock;

  @Autoinject(FaultInjector)
  protected Faults: FaultInjector;

  @Config('workflow', { defaultValue: {} })
  protected RawConfig: Partial<WorkflowConfig>;

  public readonly replicaId: string;
  protected config: WorkflowConfig;
  protected store: InstanceStore;
  protected active = new Map<string, Activation>();
  /** Set by a crash during the current tick: no further claims. */
  protected crashed = false;
  protected stopping = false;
  protected stopped?: Promise<void>;
  /** When each missing `workflow#version` was last reported. */
  protected warnedAt = new Map<string, number>();

  constructor(public readonly Options: WorkflowEngineOptions = {}) {
    super();
    this.replicaId = Options.replicaId ?? defaultReplicaId();
    const problem = identifierProblem(this.replicaId, MAX_REPLICA_ID);
    if (problem) throw new InvalidArgument(`workflow replicaId ${problem}`);
  }

  public __checkInstance__(creationOptions: unknown[]): boolean {
    const other = (creationOptions?.[0] ?? {}) as WorkflowEngineOptions;
    return (other.replicaId ?? defaultReplicaId()) === this.replicaId;
  }

  public async resolve(): Promise<void> {
    const driver = await workflowDriver();
    this.config = this.clampConcurrency(resolveWorkflowConfig(this.RawConfig), driver);
    this.store = new InstanceStore(driver, new RowLease(driver), this.replicaId);
    await this.Clock.sync();
    await super.resolve();
  }

  /** One transaction at a time (SQLite): a transactional step would block every other activation's heartbeat on this replica. */
  protected clampConcurrency(config: WorkflowConfig, driver: OrmDriver): WorkflowConfig {
    if (config.concurrency <= 1 || driver.supportedFeatures().concurrentTransactions !== false) return config;
    this.warn(
      `workflow.concurrency ${config.concurrency} clamped to 1: the '${driver.Options.Driver}' driver runs one transaction at a time, and a transactional step would stall every other activation's heartbeat`,
    );
    return { ...config, concurrency: 1 };
  }

  protected warn(message: string): void {
    this.Log.warn(message);
  }

  /** Rejects with the first crash of an activation, once every activation settled: the replica is dead (crash contract). */
  public async tick(): Promise<void> {
    if (this.stopping) return;
    const now = await this.Clock.sync();
    await this.warnMissingVersions(now);
    const defs = this.Registry.all();
    const free = this.config.concurrency - this.active.size;
    if (free <= 0 || defs.length === 0) return;
    this.crashed = false;
    const launched: Promise<void>[] = [];
    for (const row of await this.dueInstances(now, defs, free)) {
      if (this.stopping || this.crashed || this.active.size >= this.config.concurrency) break;
      if (this.active.has(row.Id)) continue;
      const claim = await this.store.lease.claim(this.store.target(row.Id), this.replicaId, this.config.leaseTtl, now, { Status: row.Status, WakeAt: row.WakeAt });
      if (!claim) continue;
      // a dead replica releases nothing: the lease expires on its own
      if (this.crashed) break;
      // stop() ran while this claim was in flight and would not wait for an activation launched after it
      if (this.stopping) {
        await this.store.release(row.Id, claim.epoch);
        break;
      }
      launched.push(this.launch(row.Id, claim.epoch, now));
    }
    const crash = (await Promise.allSettled(launched)).find((r) => r.status === 'rejected');
    if (crash) throw crash.reason;
  }

  /** Aborts every activation as `shutdown` and waits for them at most `workflow.shutdownGrace`; later ticks do nothing. */
  public stop(): Promise<void> {
    return (this.stopped ??= this.shutdown());
  }

  protected async shutdown(): Promise<void> {
    this.stopping = true;
    const running = [...this.active.values()];
    for (const a of running) a.abort('shutdown');
    if (running.length === 0) return;
    const ac = new AbortController();
    await Promise.race([Promise.allSettled(running.map((a) => a.done)), this.Timers.sleep(this.config?.shutdownGrace ?? 0, ac.signal)]);
    ac.abort();
  }

  public async dispose(): Promise<void> {
    await this.stop();
  }

  /** D5: an instance of an unregistered version stays untouched, so it is reported again once per `leaseTtl`. */
  protected async warnMissingVersions(now: number): Promise<void> {
    for (const m of await missingVersions(this.Registry)) {
      const key = `${m.workflow}#${m.version}`;
      const last = this.warnedAt.get(key);
      if (last !== undefined && now - last < this.config.leaseTtl) continue;
      this.warnedAt.set(key, now);
      this.warn(`workflow '${m.workflow}' version ${m.version} is not registered; ${m.instances} unfinished instance(s) stay untouched`);
    }
  }

  /**
   * The signalled-wait query gets a reserved share of the slots and goes first: a flood of due timers must not
   * starve an instance whose signal landed while it was being parked (D7). Both reads go to the primary.
   */
  protected async dueInstances(now: number, defs: RegisteredWorkflow[], limit: number): Promise<WorkflowInstanceModel[]> {
    const signalled = await this.signalledInstances(now, defs, Math.max(1, Math.floor(limit / 4)));
    const seen = new Set(signalled.map((r) => r.Id));
    const timed = await WorkflowInstanceModel.query()
      .onPrimary()
      .whereIn('Status', DUE_STATUSES)
      .where(leaseFree(now))
      .where(registeredVersions(defs))
      .where(dueNow(now))
      .orderBy('UpdatedAt')
      .take(limit);
    return [...signalled, ...timed.filter((r) => !seen.has(r.Id))].slice(0, limit);
  }

  /** Waiting instances with a pending event of the name they wait for: the signal landed while they were being parked. */
  protected async signalledInstances(now: number, defs: RegisteredWorkflow[], limit: number): Promise<WorkflowInstanceModel[]> {
    const driver = this.store.driver;
    const dialect = sqlDialect(driver.Options.Driver, 'due scan', 'workflow');
    const q = quoteFor(dialect);
    const cat = (...parts: string[]): string => (dialect === 'mysql' ? `CONCAT(${parts.join(', ')})` : parts.join(' || '));
    // filtered before the LIMIT: unregistered versions must not take the reserved slots
    const versions = defs.map(() => `(w.${q('Workflow')} = ? AND w.${q('Version')} = ?)`).join(' OR ');
    const rows = await selectRows<{ id: string }>(
      driver,
      `SELECT w.${q('Id')} AS id FROM ${q('__workflow')} w WHERE w.${q('Status')} = ? AND (w.${q('ClaimedBy')} IS NULL OR w.${q('ClaimedUntil')} < ?) AND (${versions}) ` +
        `AND EXISTS (SELECT 1 FROM ${q('__workflow_event')} e WHERE e.${q('InstanceId')} = w.${q('Id')} AND e.${q('State')} = ? AND (e.${q('Name')} = w.${q('WaitingFor')} OR (w.${q('WaitingFor')} = ? ` +
        // '*' waits for several names: an event counts only if a wait of its name is pending (the exact-collation key range)
        `AND EXISTS (SELECT 1 FROM ${q('__workflow_step')} s WHERE s.${q('InstanceId')} = w.${q('Id')} AND s.${q('Kind')} = ? AND s.${q('Status')} = ? ` +
        `AND s.${q('Key')} >= ${cat('?', `e.${q('Name')}`, '?')} AND s.${q('Key')} < ${cat('?', `e.${q('Name')}`, '?')})))) ` +
        `ORDER BY w.${q('UpdatedAt')} LIMIT ${Math.floor(limit)}`,
      ['waiting', now, ...defs.flatMap((d) => [d.name, d.version]), 'pending', '*', 'wait', 'pending', 'wait:', '#', 'wait:', '$'],
    );
    const ids = rows.map((r) => r.id);
    return ids.length === 0 ? [] : await WorkflowInstanceModel.query().onPrimary().whereIn('Id', ids).take(limit);
  }

  /** Rejects only with a crash; any other error of the engine's own is logged. */
  protected launch(instanceId: string, epoch: number, claimedAt: number): Promise<void> {
    const run = new AbortController();
    const compensation = new AbortController();
    const abort = (reason: AbortReason): void => {
      if (!run.signal.aborted) run.abort(reason);
      if (STOPS_COMPENSATION.has(reason) && !compensation.signal.aborted) compensation.abort(reason);
    };
    const done = this.activate(instanceId, epoch, claimedAt, { run: run.signal, compensation: compensation.signal }, abort)
      .catch((err: unknown) => {
        if (isCrash(err)) throw err;
        this.Log.error(err as Error, `workflow instance ${instanceId}: activation failed inside the engine`);
      })
      .finally(() => this.active.delete(instanceId));
    this.active.set(instanceId, { abort, done });
    return done;
  }

  /** A dead replica: every activation on it stops writing, not only the one that saw the crash. */
  protected crashAll(): void {
    this.crashed = true;
    for (const a of this.active.values()) a.abort('crashed');
  }

  /** Rejects with the error that crashed the activation, once it has stopped. */
  protected async activate(instanceId: string, epoch: number, claimedAt: number, signals: Signals, abort: (reason: AbortReason) => void): Promise<void> {
    const row = await WorkflowInstanceModel.where('Id', instanceId).onPrimary().first();
    const definition = row ? this.Registry.find(row.Workflow, row.Version) : undefined;
    if (!row || !definition) {
      await this.store.release(instanceId, epoch);
      return;
    }
    const journal = await Journal.load(instanceId);
    const deadline = definition.timeoutMs === null ? null : row.CreatedAt + definition.timeoutMs;
    // a compensation pass, a compensated cancel and a timeout found at claim replay run() only to collect the
    // compensations of the steps already taken (D6)
    const collect = row.Status === 'compensating' || (row.CancelRequested ? this.config.compensateOnCancel : deadline !== null && this.Clock.now() >= deadline);
    const ctx = new ActivationContext({
      instance: row,
      definition,
      journal,
      store: this.store,
      epoch,
      clock: this.Clock,
      faults: this.Faults,
      config: this.config,
      signal: collect ? signals.compensation : signals.run,
      log: this.Log,
      deadline: collect ? null : deadline,
      mode: collect ? 'collect' : 'run',
      onLeaseLost: () => abort('lease-lost'),
      onCrash: () => this.crashAll(),
      onJournalFailed: (err, what) => {
        this.Log.error(err as Error, `workflow instance ${instanceId}: ${what ?? 'a journal row could not be written'}; the activation is abandoned and replays later`);
        abort('journal-failed');
      },
      timers: this.Timers,
    });
    const heartbeat = this.heartbeat(ctx, claimedAt, abort);
    signals.compensation.addEventListener(
      'abort',
      () => {
        if (signals.compensation.reason === 'crashed') void heartbeat.stop(0);
      },
      { once: true },
    );
    heartbeat.start();
    let decision: Decision;
    try {
      decision = this.alive(ctx, signals, await this.runPass(row, ctx, definition, journal, signals, abort));
      // under the heartbeat: a compensation longer than leaseTtl keeps the lease, so no other replica runs it again (D6)
      if (decision.kind === 'write' && this.compensates(row, ctx, decision.patch)) decision = this.alive(ctx, signals, await this.compensation(row, ctx, decision.patch, signals.compensation));
    } finally {
      await heartbeat.stop(this.config.shutdownGrace);
    }
    await this.finish(row, ctx, decision);
    if (ctx.crashError !== undefined) throw ctx.crashError as Error;
  }

  /** A crash elsewhere on this replica may come after a cancel, which the run signal keeps as its reason. */
  protected alive(ctx: ActivationContext, signals: Signals, decision: Decision): Decision {
    return ctx.crashed || signals.compensation.reason === 'crashed' ? { kind: 'discard' } : decision;
  }

  /** Runs run(), or replays it to collect compensations, and decides what it ended with. */
  protected async runPass(row: WorkflowInstanceModel, ctx: ActivationContext, definition: RegisteredWorkflow, journal: Journal, signals: Signals, abort: (reason: AbortReason) => void): Promise<Decision> {
    if (row.Status === 'compensating') {
      await this.execute(ctx, definition, signals.compensation);
      return this.resumed(row, ctx, signals.compensation);
    }
    let outcome: Outcome = { kind: 'aborted' };
    if (row.CancelRequested) abort('cancelled');
    if (ctx.mode === 'collect') await this.execute(ctx, definition, signals.compensation);
    // collecting without a cancel: the deadline had passed at claim
    if (ctx.mode === 'collect' && !row.CancelRequested) {
      return signals.compensation.aborted ? { kind: 'release' } : this.failed(INTERRUPTION_REASON.timeout, serializeError(ctx.expire()), this.Clock.now());
    }
    if (!row.CancelRequested) {
      const disarm = this.expireAt(ctx, ctx.deadline, abort);
      try {
        outcome = await this.execute(ctx, definition, signals.run);
      } finally {
        disarm();
      }
    }
    return this.decide(row, ctx, journal, outcome, signals.run);
  }

  /** A compensating instance keeps the failure (or cancel) it compensates for. */
  protected resumed(row: WorkflowInstanceModel, ctx: ActivationContext, signal: AbortSignal): Decision {
    if (signal.aborted) return { kind: 'release' };
    const now = this.Clock.now();
    const original: Patch = { Status: row.CancelRequested ? 'cancelled' : 'failed', Reason: row.Reason, Error: row.Error, WakeAt: null, WaitingFor: null, FinishedAt: now };
    const i = ctx.interruption;
    // the code changed under the instance: the collected compensations may not be all the steps it took
    if (i?.kind === 'nondeterminism') return this.compensationFailed(serializeError(i.error), original, now);
    return { kind: 'write', patch: original };
  }

  protected compensates(row: WorkflowInstanceModel, ctx: ActivationContext, patch: Patch): boolean {
    if (ctx.compensations.length === 0 || UNCOMPENSATED.has(patch.Reason ?? '')) return false;
    if (row.Status === 'compensating' || patch.Status === 'failed') return true;
    return patch.Status === 'cancelled' && this.config.compensateOnCancel;
  }

  /** Marks the instance compensating, so a crash resumes the pass, then runs it. */
  protected async compensation(row: WorkflowInstanceModel, ctx: ActivationContext, original: Patch, signal: AbortSignal): Promise<Decision> {
    if (row.Status !== 'compensating') {
      try {
        await this.store.update(row.Id, ctx.epoch, { Status: 'compensating', Reason: original.Reason ?? null, Error: original.Error ?? null, WakeAt: null, WaitingFor: null, UpdatedAt: this.Clock.now() });
      } catch (err) {
        if (err instanceof LeaseLostError) return { kind: 'release' };
        throw err;
      }
    }
    const result = await ctx.compensate(signal);
    const now = this.Clock.now();
    switch (result.kind) {
      case 'done':
        return { kind: 'write', patch: { Status: original.Status === 'cancelled' ? 'cancelled' : 'compensated', Reason: original.Reason ?? null, Error: original.Error ?? null, WakeAt: null, WaitingFor: null, FinishedAt: now } };
      case 'park':
        return { kind: 'write', patch: { Status: 'compensating', WakeAt: result.wakeAt } };
      case 'failed':
        return this.compensationFailed(result.error, original, now);
      default:
        return { kind: 'release' };
    }
  }

  /** The failure being compensated for travels in `details`, so retry() can put it back. */
  protected compensationFailed(error: SerializedError, original: Patch, now: number): Decision {
    return this.failed('compensation-failed', { ...error, details: { original: original.Error ?? null, originalReason: original.Reason ?? null } }, now);
  }

  /** A step still running at the deadline must not let the instance end `completed`. */
  protected expireAt(ctx: ActivationContext, deadline: number | null, abort: (reason: AbortReason) => void): () => void {
    if (deadline === null) return () => undefined;
    const handle = this.Timers.setTimeout(() => {
      ctx.expire();
      abort('timeout');
    }, deadline - this.Clock.now());
    return () => this.Timers.clearTimeout(handle);
  }

  protected async execute(ctx: ActivationContext, definition: RegisteredWorkflow, signal: AbortSignal): Promise<Outcome> {
    const workflow = await Promise.resolve(DI.resolve(definition.target));
    // a synchronous throw from run() is a rejected run like any other
    const work = new Promise<unknown>((resolve) => resolve(workflow.run(ctx)));
    ctx.observe(work);
    const outcome = await this.settle(work, signal, ctx.suspended);
    if (outcome.kind === 'error' && isCrash(outcome.error)) ctx.crash(outcome.error);
    if (signal.aborted) await this.bounded(ctx.drain());
    else await ctx.drain();
    return outcome;
  }

  /** After an abort or a park, `run()` gets `shutdownGrace` to settle: one awaiting a promise that never settles cannot hold the lease. */
  protected async settle(work: Promise<unknown>, signal: AbortSignal, parked: Promise<void>): Promise<Outcome> {
    const guarded = work.then(
      (value): Outcome => ({ kind: 'ok', value }),
      (error): Outcome => ({ kind: 'error', error }),
    );
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) return resolve('aborted');
      signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    const first = await Promise.race([guarded, aborted, parked.then(() => 'aborted' as const)]);
    if (first !== 'aborted') return first;
    const ac = new AbortController();
    const late = await Promise.race([guarded, this.Timers.sleep(this.config.shutdownGrace, ac.signal).then(() => null)]);
    ac.abort();
    return late ?? { kind: 'aborted' };
  }

  protected async bounded(work: Promise<unknown>): Promise<void> {
    const ac = new AbortController();
    await Promise.race([work.catch(() => undefined), this.Timers.sleep(this.config.shutdownGrace, ac.signal)]);
    ac.abort();
  }

  protected heartbeat(ctx: ActivationContext, claimedAt: number, abort: (reason: AbortReason) => void): Heartbeat {
    const { instanceId, epoch } = ctx;
    const target = this.store.target(instanceId);
    const ttl = this.config.leaseTtl;
    const renewEveryMs = Math.floor(ttl / 3);
    return new Heartbeat({
      timers: this.Timers,
      now: () => this.Clock.now(),
      intervalMs: renewEveryMs,
      renewEveryMs,
      leaseTtlMs: ttl,
      leaseStartedAt: claimedAt,
      needsFlush: () => false,
      renew: async () => {
        await this.Faults.point('workflow.lease-renew', { instanceId, replicaId: this.replicaId });
        if (!(await this.store.lease.renew(target, this.replicaId, epoch, ttl, this.Clock.now()))) return { ok: false, cancelRequested: false };
        const row = await WorkflowInstanceModel.where('Id', instanceId).onPrimary().first();
        return { ok: true, cancelRequested: !!row?.CancelRequested };
      },
      onLost: () => abort('lease-lost'),
      onCancel: () => abort('cancelled'),
      onError: (err) => {
        if (isCrash(err)) ctx.crash(err);
        else this.Log.warn(err as Error, `workflow instance ${instanceId}: lease renewal failed`);
      },
    });
  }

  /** Only the fenced status write and the release: everything that takes time ran under the heartbeat. */
  protected async finish(row: WorkflowInstanceModel, ctx: ActivationContext, decision: Decision): Promise<void> {
    if (decision.kind === 'discard') return;
    try {
      if (decision.kind === 'write') {
        await this.store.update(row.Id, ctx.epoch, { ...decision.patch, Attempt: row.Attempt + 1, UpdatedAt: this.Clock.now() });
        if (PARKED.has(decision.patch.Status as string)) await this.wakeIfCancelled(row.Id, ctx.epoch);
      }
      await this.store.release(row.Id, ctx.epoch);
    } catch (err) {
      if (!(err instanceof LeaseLostError)) throw err;
      this.warn(`workflow instance ${row.Id}: the lease was lost before the activation was recorded`);
    }
  }

  /** A cancel() that landed while this activation parked set WakeAt, which the park just overwrote. */
  protected async wakeIfCancelled(instanceId: string, epoch: number): Promise<void> {
    await WorkflowInstanceModel.update({ WakeAt: this.Clock.now() }).where(this.store.fence(instanceId, epoch)).where('CancelRequested', true);
  }

  protected async decide(row: WorkflowInstanceModel, ctx: ActivationContext, journal: Journal, outcome: Outcome, signal: AbortSignal): Promise<Decision> {
    const reason = ctx.crashed ? 'crashed' : signal.aborted ? (signal.reason as AbortReason) : undefined;
    // a dead replica writes and releases nothing: its lease expires on its own
    if (reason === 'crashed') return { kind: 'discard' };
    // an abandoned activation writes no status; the fenced release affects 0 rows after a takeover and otherwise
    // frees the row at once, so a self-detected expiry never waits out the TTL a second time
    if (reason === 'lease-lost' || reason === 'journal-failed') return { kind: 'release' };
    const now = this.Clock.now();
    const i = ctx.interruption;
    if (i && i.kind !== 'park') return this.failed(INTERRUPTION_REASON[i.kind], serializeError(i.error), now);
    if (reason === 'shutdown') return { kind: 'release' };
    if (reason === 'cancelled') return this.cancelled(row.Id, now);
    if (i?.kind === 'park') return { kind: 'write', patch: this.parked(i.park, ctx.deadline) };
    if (outcome.kind === 'ok') return this.completed(outcome.value, journal, now);
    if (outcome.kind === 'error') return this.failed('error', serializeError(outcome.error), now);
    return { kind: 'release' };
  }

  /** A sleep or a backoff past the instance deadline wakes at the deadline, which then fails the instance. */
  protected parked(park: Park, deadline: number | null): Patch {
    let wakeAt = park.wakeAt;
    if (deadline !== null) wakeAt = wakeAt === null ? (park.status === 'running' ? null : deadline) : Math.min(wakeAt, deadline);
    return { Status: park.status, WakeAt: wakeAt, WaitingFor: park.waitingFor };
  }

  protected completed(value: unknown, journal: Journal, now: number): Decision {
    // the journal recorded a step this code returned without asking for: the code changed under the instance
    const unvisited = journal.unvisited();
    if (unvisited.length > 0) {
      const error = new NonDeterminismError(`the run ended without asking for '${unvisited.slice(0, 3).join("', '")}', which the journal recorded`);
      return this.failed(INTERRUPTION_REASON.nondeterminism, serializeError(error), now);
    }
    const json = value === undefined ? 'null' : safeStringify(value);
    if (json === undefined) return this.failed('error', { name: 'WorkflowResultInvalid', message: 'the workflow returned a value that is not JSON-serializable' }, now);
    const bytes = Buffer.byteLength(json);
    if (bytes > this.config.maxStepResultBytes) {
      return this.failed('error', { name: 'WorkflowResultInvalid', message: `the workflow returned ${bytes} bytes of JSON, over workflow.maxStepResultBytes (${this.config.maxStepResultBytes})` }, now);
    }
    return { kind: 'write', patch: { Status: 'completed', Result: JSON.parse(json) as unknown, Reason: null, Error: null, WakeAt: null, WaitingFor: null, FinishedAt: now } };
  }

  protected failed(reason: string, error: SerializedError, now: number): Decision {
    return { kind: 'write', patch: { Status: 'failed', Reason: reason, Error: error, WakeAt: null, WaitingFor: null, FinishedAt: now } };
  }

  /** `cancel()` may have stored its reason after this activation read the row. */
  protected async cancelled(instanceId: string, now: number): Promise<Decision> {
    const fresh = await WorkflowInstanceModel.where('Id', instanceId).onPrimary().first();
    return { kind: 'write', patch: { Status: 'cancelled', Reason: fresh?.Reason ?? 'cancelled', WakeAt: null, WaitingFor: null, FinishedAt: now } };
  }
}
