import { AsyncLocalStorage } from 'node:async_hooks';
import { computeBackoff, isRetryable, type Clock, type DbClock, type FaultInjector, type FaultPointName, type NormalizedRetry, type RetryPolicyOptions } from '@spinajs/durable';
import { InvalidArgument, InvalidOperation, NotSupported } from '@spinajs/exceptions';
import type { Log } from '@spinajs/log-common';
import type { QueueEvent, QueueJob } from '@spinajs/queue';
import type { SerializedError, StepKind, StepMeta, StepStatus, WaitForEventOptions, WorkflowContext, WorkflowEvent, WorkflowStepOptions } from './contract.js';
import { isCrash, LeaseLostError, NonDeterminismError, serializeError, WorkflowAborted, WorkflowFailure, WorkflowNestingError, WorkflowStepFailed, WorkflowStepResultTooLarge, WorkflowSuspended, type AbortReason } from './errors.js';
import { ReplayGate } from './gate.js';
import { identifierProblem } from './identifier.js';
import type { Journal, StepRow } from './journal.js';
import { safeStringify } from './json.js';
import { normalizeRetry, unitHash } from './policy.js';
import type { WorkflowInstanceModel } from './models/WorkflowInstanceModel.js';
import type { RegisteredWorkflow } from './registry.js';
import type { InstanceStore, StepWrite } from './store.js';
import type { WorkflowConfig } from './workflow-config.js';

export interface Park {
  status: 'running' | 'sleeping' | 'waiting';
  wakeAt: number | null;
  waitingFor: string | null;
}

export type Interruption = { kind: 'park'; park: Park } | { kind: 'fail'; error: WorkflowFailure } | { kind: 'timeout'; error: Error } | { kind: 'nondeterminism'; error: NonDeterminismError };

export interface ActivationInit {
  instance: WorkflowInstanceModel;
  definition: RegisteredWorkflow;
  journal: Journal;
  store: InstanceStore;
  epoch: number;
  clock: DbClock;
  faults: FaultInjector;
  config: WorkflowConfig;
  signal: AbortSignal;
  log: Log;
  /** A fenced write matched no row: another replica owns the instance now. */
  onLeaseLost: () => void;
  /** A crash reached the activation: as far as the instance is concerned, this replica is dead. */
  onCrash: (err: unknown) => void;
  /** A journal row failed to commit for a reason other than a lost lease or a crash: nothing of this activation may commit after it. */
  onJournalFailed: (err: unknown) => void;
  /** Arms the coarse fallback that fails a replay waiting for a recorded call that never comes; none without it. */
  timers?: Clock;
}

export interface Op {
  kind: StepKind;
  name: string;
  key: string;
  seq: number;
  /** Results delivered to run() before this call. */
  after: number;
  /** Set once the operation's result is journaled. */
  order?: number;
}

type StepFn<T> = (s: { signal: AbortSignal; attempt: number }) => Promise<T> | T;

interface Save {
  status: StepStatus;
  attempt: number;
  startedAt: number;
  result?: { value: unknown };
  error?: SerializedError | null;
  meta?: StepMeta | null;
  finished?: boolean;
}

const MAX_NAME = 128;
const PRIORITY: Record<Interruption['kind'], number> = { park: 0, fail: 1, timeout: 2, nondeterminism: 3 };
const stepScope = new AsyncLocalStorage<string>();

/** Parallel operations parked at once: the instance wakes for whichever is due first and replays the others. */
function earlierPark(a: Park, b: Park): Park {
  const rank = (p: Park): number => p.wakeAt ?? (p.status === 'running' ? -Infinity : Infinity);
  return rank(b) < rank(a) ? b : a;
}

/**
 * What `run()` sees during one activation. Each durable operation takes the next journal key
 * `${kind}:${name}#${occurrence}` (D3): a recorded key returns its recorded outcome, an unrecorded one
 * executes and journals fenced by the claim epoch, and a blocking one that cannot finish parks the instance.
 */
export class ActivationContext implements WorkflowContext {
  public readonly instanceId: string;
  public readonly workflow: string;
  public readonly version: number;
  public readonly input: unknown;
  public readonly signal: AbortSignal;
  public readonly log: Log;
  /** Read by the engine whatever `run()` did with the error that came with it. */
  public interruption: Interruption | null = null;
  public crashed = false;
  /** What crashed the activation; unset when another activation's crash took this one down. */
  public crashError: unknown;
  protected journalFailed = false;

  protected seq = 0;
  protected occurrences = new Map<string, number>();
  protected inflight = new Set<Promise<unknown>>();
  protected readonly gate: ReplayGate;
  /** Journal writes of non-transactional operations, in call order: a marker never commits after a later step. */
  protected writes: Promise<unknown> = Promise.resolve();

  constructor(protected readonly init: ActivationInit) {
    const i = init.instance;
    this.instanceId = i.Id;
    this.workflow = i.Workflow;
    this.version = i.Version;
    this.input = i.Input ?? null;
    this.signal = init.signal;
    this.gate = new ReplayGate(init.journal.rows(), init.journal.causal, (error) => this.interrupt({ kind: 'nondeterminism', error }), init.timers && { timers: init.timers, ms: init.config.leaseTtl });
    init.signal.addEventListener(
      'abort',
      () => {
        // a crash elsewhere on this replica (the heartbeat, another activation): no later write may commit
        if (init.signal.reason === 'crashed') this.crashed = true;
        this.gate.abort(new WorkflowAborted(this.abortReason()));
      },
      { once: true },
    );
    this.log = init.log.child('WORKFLOW', { instanceId: i.Id, workflow: i.Workflow, version: i.Version });
  }

  public get epoch(): number {
    return this.init.epoch;
  }

  public step<T>(name: string, fn: StepFn<T>, opts: WorkflowStepOptions<T> = {}): Promise<T> {
    return this.begin('step', name, (op) => this.runStep(op, fn, opts));
  }

  public sleep(_duration: string | number, _name?: string): Promise<void> {
    return Promise.reject(new NotSupported('ctx.sleep()'));
  }

  public sleepUntil(_at: number | Date, _name?: string): Promise<void> {
    return Promise.reject(new NotSupported('ctx.sleepUntil()'));
  }

  public waitForEvent<T = unknown>(_name: string, _opts?: WaitForEventOptions): Promise<WorkflowEvent<T> | undefined> {
    return Promise.reject(new NotSupported('ctx.waitForEvent()'));
  }

  public emit(_name: string, _message: QueueEvent | QueueJob): Promise<void> {
    return Promise.reject(new NotSupported('ctx.emit()'));
  }

  public now(): number {
    throw new NotSupported('ctx.now()');
  }

  public uuid(): string {
    throw new NotSupported('ctx.uuid()');
  }

  public random(): number {
    throw new NotSupported('ctx.random()');
  }

  public fail(reason: string, details?: unknown): never {
    const error = new WorkflowFailure(reason, details);
    this.interrupt({ kind: 'fail', error });
    throw error;
  }

  /** Waits for every operation still in flight, e.g. the sibling of a suspended `Promise.all`. */
  public async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    await this.writes;
  }

  /** `next()` runs synchronously at the call, so parallel operations take their keys in call order. */
  protected async begin<T>(kind: StepKind, name: string, run: (op: Op) => Promise<T>): Promise<T> {
    return this.track(run(this.next(kind, name)));
  }

  protected next(kind: StepKind, name: string): Op {
    const outer = stepScope.getStore();
    if (outer !== undefined) throw new WorkflowNestingError(`'${name}' (${kind}) was called inside step '${outer}'; durable operations cannot nest`);
    const problem = identifierProblem(name, MAX_NAME);
    if (problem) throw new InvalidArgument(`${kind} name ${problem}, got ${JSON.stringify(name.slice(0, 40))}`);
    this.assertLive();
    const base = `${kind}:${name}`;
    const occurrence = (this.occurrences.get(base) ?? 0) + 1;
    this.occurrences.set(base, occurrence);
    const op: Op = { kind, name, key: `${base}#${occurrence}`, seq: ++this.seq, after: this.gate.delivered };
    try {
      this.init.journal.check(op.seq, op.key, op.after);
    } catch (err) {
      this.interrupt({ kind: 'nondeterminism', error: err as NonDeterminismError });
      throw err;
    }
    this.gate.call(op.key);
    return op;
  }

  protected assertLive(): void {
    if (this.crashed) throw new WorkflowAborted('crashed');
    if (this.journalFailed) throw new WorkflowAborted('journal-failed');
    const i = this.interruption;
    // typed unknown: WorkflowSuspended is deliberately not an Error (see its class)
    if (i?.kind === 'park') throw new WorkflowSuspended() as unknown;
    if (i) throw i.error;
    if (this.signal.aborted) throw new WorkflowAborted(this.abortReason());
  }

  protected interrupt(next: Interruption): void {
    const cur = this.interruption;
    if (!cur) this.interruption = next;
    else if (cur.kind === 'park' && next.kind === 'park') this.interruption = { kind: 'park', park: earlierPark(cur.park, next.park) };
    else if (PRIORITY[next.kind] > PRIORITY[cur.kind]) this.interruption = next;
    const now = this.interruption;
    if (now) this.gate.abort(now.kind === 'park' ? new WorkflowSuspended() : now.error);
  }

  protected track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const untrack = (): void => {
      this.inflight.delete(p);
    };
    void p.then(untrack, untrack);
    return p;
  }

  protected enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const p = this.writes.then(work);
    this.writes = p.catch(() => undefined);
    return p;
  }

  protected abortReason(): AbortReason {
    if (this.crashed) return 'crashed';
    if (this.journalFailed) return 'journal-failed';
    return (this.signal.reason as AbortReason | undefined) ?? 'lease-lost';
  }

  /** Also called by the engine for a crash from `run()` itself or from the heartbeat. */
  public crash(err: unknown): void {
    if (this.crashed) return;
    this.crashed = true;
    this.crashError = err;
    this.gate.abort(new WorkflowAborted('crashed'));
    this.init.onCrash(err);
  }

  /** A journal write that failed leaves a hole a replay would fill differently (D3): no later write of this activation may commit. */
  protected abandonJournal(err: unknown): void {
    if (this.journalFailed) return;
    this.journalFailed = true;
    this.gate.abort(new WorkflowAborted('journal-failed'));
    this.init.onJournalFailed(err);
  }

  /** Amendment 20: a journal row that failed for any reason but a crash or a lost lease abandons the activation. */
  protected journalWriteFailed(err: unknown): unknown {
    if (isCrash(err)) this.crash(err);
    if (isCrash(err) || err instanceof WorkflowAborted) return err;
    this.abandonJournal(err);
    return new WorkflowAborted('journal-failed');
  }

  protected async fault(name: FaultPointName, key: string): Promise<void> {
    try {
      await this.init.faults.point(name, { instanceId: this.instanceId, key });
    } catch (err) {
      if (isCrash(err)) this.crash(err);
      throw err;
    }
  }

  protected async runStep<T>(op: Op, fn: StepFn<T>, opts: WorkflowStepOptions<T>): Promise<T> {
    const { journal } = this.init;
    const rec = journal.get(op.key);
    if (rec?.Status === 'succeeded' || rec?.Status === 'failed') {
      await this.released(op);
      if (rec.Status === 'succeeded') return journal.value(op.key) as T;
      throw new WorkflowStepFailed(op.name, rec.Error ?? { name: 'Error', message: 'step failed' });
    }
    const wakeAt = rec?.Status === 'retrying' ? rec.Meta?.wakeAt : undefined;
    if (wakeAt !== undefined && this.init.clock.now() < wakeAt) {
      // A parallel step woke the instance early and this one waits out its own backoff. Parking one turn later lets
      // the siblings called in the same synchronous run (a Promise.all) take their keys and run.
      await Promise.resolve();
      this.interrupt({ kind: 'park', park: { status: 'running', wakeAt, waitingFor: null } });
      throw new WorkflowSuspended() as unknown;
    }
    return this.runLive(op, fn, opts, rec);
  }

  /** The gate fails its waiters only when the activation has ended; they get what ended it. */
  protected async released(op: Op): Promise<void> {
    try {
      await this.gate.wait(op.key);
    } catch (err) {
      this.assertLive();
      throw err;
    }
  }

  protected async runLive<T>(op: Op, fn: StepFn<T>, opts: WorkflowStepOptions<T>, rec: StepRow | undefined): Promise<T> {
    const { clock } = this.init;
    const attempt = (rec?.Attempt ?? 0) + 1;
    const startedAt = clock.now();
    let value: T;
    try {
      value = await this.execute(op, fn, attempt, startedAt, opts);
    } catch (err) {
      throw await this.stepFailed(op, err, attempt, startedAt, opts);
    }
    await this.fault('workflow.after-journal', op.key);
    await this.gate.live(op.order);
    return value;
  }

  protected async execute<T>(op: Op, fn: StepFn<T>, attempt: number, startedAt: number, opts: WorkflowStepOptions<T>): Promise<T> {
    const call = (): Promise<T> => stepScope.run(op.name, () => Promise.resolve().then(() => fn({ signal: this.signal, attempt })));
    const journalIt = async (value: T): Promise<T> => {
      const kept = opts.persistResult === false ? undefined : this.checkResult(op, value);
      await this.saveStep(op, { status: 'succeeded', attempt, startedAt, result: kept === undefined ? undefined : { value: kept }, meta: opts.compensate ? { compensate: true } : null, finished: true }).catch((err: unknown) => {
        throw this.journalWriteFailed(err);
      });
      return opts.persistResult === false ? value : (kept as T);
    };
    if (opts.transactional) {
      // earlier markers first; the journal write inside the transaction bypasses the queue, which could wait on it
      await this.writes;
      return this.init.store.driver.transaction(async () => {
        const value = await call();
        await this.fault('workflow.after-step-fn', op.key);
        return journalIt(value);
      });
    }
    const value = await call();
    await this.fault('workflow.after-step-fn', op.key);
    return this.enqueueWrite(() => journalIt(value));
  }

  /** The value a replay will see: its JSON form, within `maxStepResultBytes`. */
  protected checkResult(op: Op, value: unknown): unknown {
    if (value === undefined) return undefined;
    const limit = this.init.config.maxStepResultBytes;
    const json = safeStringify(value);
    if (json === undefined) throw new WorkflowStepResultTooLarge(op.name, null, limit);
    const bytes = Buffer.byteLength(json);
    if (bytes > limit) throw new WorkflowStepResultTooLarge(op.name, bytes, limit);
    return JSON.parse(json) as unknown;
  }

  /** Returns what the step throws to `run()`: a retry parks the instance, a final failure is journaled. */
  protected async stepFailed<T>(op: Op, err: unknown, attempt: number, startedAt: number, opts: WorkflowStepOptions<T>): Promise<unknown> {
    if (this.crashed || isCrash(err)) {
      this.crash(err);
      return err;
    }
    if (err instanceof LeaseLostError || err instanceof WorkflowAborted || this.signal.aborted) return new WorkflowAborted(this.abortReason());
    const error = serializeError(err, op.name);
    const retry = this.retryPolicy(opts.retry);
    const again = isRetryable(retry, err) && attempt < retry.attempts;
    // the row carries its own wake time: a replay before it parks again instead of running the attempt early
    const wakeAt = again ? this.init.clock.now() + computeBackoff(retry, attempt, () => unitHash(`${this.instanceId}:${op.key}:${attempt}`)) : null;
    try {
      await this.enqueueWrite(() => this.saveStep(op, { status: again ? 'retrying' : 'failed', attempt, startedAt, error, meta: wakeAt === null ? null : { wakeAt }, finished: true }));
    } catch (writeErr) {
      return this.journalWriteFailed(writeErr);
    }
    if (wakeAt === null) {
      await this.gate.live(op.order);
      return new WorkflowStepFailed(op.name, error, err);
    }
    this.interrupt({ kind: 'park', park: { status: 'running', wakeAt, waitingFor: null } });
    return new WorkflowSuspended();
  }

  protected retryPolicy(own: RetryPolicyOptions | undefined): NormalizedRetry {
    return normalizeRetry(own ?? this.init.definition.options.retry ?? this.init.config.retry, `workflow '${this.workflow}'`);
  }

  protected stepWrite(op: Op, s: Save, now: number): StepWrite {
    return {
      instanceId: this.instanceId,
      seq: op.seq,
      key: op.key,
      kind: op.kind,
      status: s.status,
      attempt: s.attempt,
      result: s.result,
      error: s.error,
      meta: s.meta,
      startedAt: s.startedAt,
      finishedAt: s.finished ? now : null,
    };
  }

  /** Runs a fenced write; a lost claim aborts the activation and surfaces as `WorkflowAborted('lease-lost')`. */
  protected async guarded<T>(work: () => Promise<T>): Promise<T> {
    if (this.crashed) throw new WorkflowAborted('crashed');
    if (this.journalFailed) throw new WorkflowAborted('journal-failed');
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof LeaseLostError)) throw err;
      this.init.onLeaseLost();
      throw new WorkflowAborted('lease-lost');
    }
  }

  protected async saveStep(op: Op, s: Save): Promise<StepRow> {
    if (this.crashed) throw new WorkflowAborted('crashed');
    if (this.journalFailed) throw new WorkflowAborted('journal-failed');
    await this.fault('workflow.before-journal', op.key);
    const { store, journal, clock, epoch } = this.init;
    if (journal.causal && !Number.isInteger(op.after)) throw new InvalidOperation(`'${op.key}' has no Meta.after: the journal would lose its causality metadata`);
    const final = s.status === 'succeeded' || s.status === 'failed';
    const kept = s.meta === undefined ? journal.get(op.key)?.Meta : s.meta;
    const row = await this.guarded(() => {
      const now = clock.now();
      return store.fenced(this.instanceId, epoch, now, () => {
        // Taken under the row lock the fence UPDATE holds until commit, so the order is the commit order.
        const meta: StepMeta = { ...kept, after: op.after, ...(final ? { order: journal.nextOrder() } : {}) };
        op.order = meta.order;
        return store.saveStep(journal.get(op.key), this.stepWrite(op, { ...s, meta }, now));
      });
    });
    journal.record(row);
    return row;
  }
}
