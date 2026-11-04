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

interface Activation {
  abort(reason: AbortReason): void;
  done: Promise<void>;
}

const MAX_REPLICA_ID = 64;
const DUE_STATUSES = ['running', 'sleeping', 'waiting'];
const PARKED = new Set(['running', 'sleeping', 'waiting']);
const INTERRUPTION_REASON = { fail: 'fail', timeout: 'timeout', nondeterminism: 'non-determinism' } as const;

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

/** Semantic 1: running with no wake time, or any of the due statuses whose wake time has come. */
function dueNow(now: number) {
  return function (this: IWhereBuilder<unknown>) {
    this.where(function (this: IWhereBuilder<unknown>) {
      this.where('Status', 'running').whereNull('WakeAt');
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
    const q = quoteFor(sqlDialect(driver.Options.Driver, 'due scan', 'workflow'));
    // filtered before the LIMIT: unregistered versions must not take the reserved slots
    const versions = defs.map(() => `(w.${q('Workflow')} = ? AND w.${q('Version')} = ?)`).join(' OR ');
    const rows = await selectRows<{ id: string }>(
      driver,
      `SELECT w.${q('Id')} AS id FROM ${q('__workflow')} w WHERE w.${q('Status')} = ? AND (w.${q('ClaimedBy')} IS NULL OR w.${q('ClaimedUntil')} < ?) AND (${versions}) ` +
        `AND EXISTS (SELECT 1 FROM ${q('__workflow_event')} e WHERE e.${q('InstanceId')} = w.${q('Id')} AND e.${q('Name')} = w.${q('WaitingFor')} AND e.${q('State')} = ?) ` +
        `ORDER BY w.${q('UpdatedAt')} LIMIT ${Math.floor(limit)}`,
      ['waiting', now, ...defs.flatMap((d) => [d.name, d.version]), 'pending'],
    );
    const ids = rows.map((r) => r.id);
    return ids.length === 0 ? [] : await WorkflowInstanceModel.query().onPrimary().whereIn('Id', ids).take(limit);
  }

  /** Rejects only with a crash; any other error of the engine's own is logged. */
  protected launch(instanceId: string, epoch: number, claimedAt: number): Promise<void> {
    const ac = new AbortController();
    const abort = (reason: AbortReason): void => {
      if (!ac.signal.aborted) ac.abort(reason);
    };
    const done = this.activate(instanceId, epoch, claimedAt, ac.signal, abort)
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
  protected async activate(instanceId: string, epoch: number, claimedAt: number, signal: AbortSignal, abort: (reason: AbortReason) => void): Promise<void> {
    const row = await WorkflowInstanceModel.where('Id', instanceId).onPrimary().first();
    const definition = row ? this.Registry.find(row.Workflow, row.Version) : undefined;
    if (!row || !definition) {
      await this.store.release(instanceId, epoch);
      return;
    }
    const journal = await Journal.load(instanceId);
    const deadline = definition.timeoutMs === null ? null : row.CreatedAt + definition.timeoutMs;
    const ctx = new ActivationContext({
      instance: row,
      definition,
      journal,
      store: this.store,
      epoch,
      clock: this.Clock,
      faults: this.Faults,
      config: this.config,
      signal,
      log: this.Log,
      deadline,
      onLeaseLost: () => abort('lease-lost'),
      onCrash: () => this.crashAll(),
      onJournalFailed: (err, what) => {
        this.Log.error(err as Error, `workflow instance ${instanceId}: ${what ?? 'a journal row could not be written'}; the activation is abandoned and replays later`);
        abort('journal-failed');
      },
      timers: this.Timers,
    });
    const heartbeat = this.heartbeat(ctx, claimedAt, abort);
    signal.addEventListener(
      'abort',
      () => {
        if (signal.reason === 'crashed') void heartbeat.stop(0);
      },
      { once: true },
    );
    heartbeat.start();
    let outcome: Outcome = { kind: 'aborted' };
    let disarm = (): void => undefined;
    try {
      if (row.CancelRequested) abort('cancelled');
      else if (deadline !== null && this.Clock.now() >= deadline) ctx.expire();
      else {
        disarm = this.expireAt(ctx, deadline, abort);
        outcome = await this.execute(ctx, definition, signal);
      }
    } finally {
      disarm();
      await heartbeat.stop(this.config.shutdownGrace);
    }
    await this.finish(row, ctx, journal, outcome, signal);
    if (ctx.crashError !== undefined) throw ctx.crashError as Error;
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
    const outcome = await this.settle(work, signal);
    if (outcome.kind === 'error' && isCrash(outcome.error)) ctx.crash(outcome.error);
    if (signal.aborted) await this.bounded(ctx.drain());
    else await ctx.drain();
    return outcome;
  }

  /** After an abort, `run()` gets `shutdownGrace` to settle. */
  protected async settle(work: Promise<unknown>, signal: AbortSignal): Promise<Outcome> {
    const guarded = work.then(
      (value): Outcome => ({ kind: 'ok', value }),
      (error): Outcome => ({ kind: 'error', error }),
    );
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) return resolve('aborted');
      signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    const first = await Promise.race([guarded, aborted]);
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

  protected async finish(row: WorkflowInstanceModel, ctx: ActivationContext, journal: Journal, outcome: Outcome, signal: AbortSignal): Promise<void> {
    const decision = await this.decide(row, ctx, journal, outcome, signal);
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
