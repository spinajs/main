import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { computeBackoff, isRetryable, parseDuration, type Clock, type DbClock, type FaultInjector, type FaultPointName, type NormalizedRetry, type RetryPolicyOptions } from '@spinajs/durable';
import { InvalidArgument, InvalidOperation, NotSupported } from '@spinajs/exceptions';
import type { Log } from '@spinajs/log-common';
import type { QueueEvent, QueueJob } from '@spinajs/queue';
import { v5 as uuidv5 } from 'uuid';
import type { CompensationContext, SerializedError, StepKind, StepMeta, StepStatus, WaitForEventOptions, WorkflowContext, WorkflowEvent, WorkflowStepOptions } from './contract.js';
import { isCrash, LeaseLostError, NonDeterminismError, serializeError, WorkflowAborted, WorkflowFailure, WorkflowNestingError, WorkflowStepFailed, WorkflowStepResultTooLarge, WorkflowSuspended, WorkflowTimeout, type AbortReason } from './errors.js';
import { nextMacrotask, ReplayGate } from './gate.js';
import { eventNameProblem, identifierProblem } from './identifier.js';
import { COMPENSATION_SEQ_BASE, type Journal, type StepRow } from './journal.js';
import { safeStringify } from './json.js';
import { WorkflowEventModel } from './models/WorkflowEventModel.js';
import { normalizeRetry, unitHash } from './policy.js';
import type { WorkflowInstanceModel } from './models/WorkflowInstanceModel.js';
import type { RegisteredWorkflow } from './registry.js';
import { SignalAuthorizer } from './signals.js';
import type { InstanceStore, StepWrite } from './store.js';
import type { WorkflowConfig } from './workflow-config.js';

export interface Park {
  status: 'running' | 'sleeping' | 'waiting';
  wakeAt: number | null;
  waitingFor: string | null;
}

export type Interruption = { kind: 'park'; park: Park } | { kind: 'fail'; error: WorkflowFailure } | { kind: 'timeout'; error: Error } | { kind: 'nondeterminism'; error: NonDeterminismError };

export interface RegisteredCompensation {
  /** The key of the step it undoes. */
  key: string;
  name: string;
  /** The step's `Meta.order`: compensations run newest first, in the same order on every replay. */
  order: number;
  retry: NormalizedRetry;
  run: (ctx: CompensationContext) => Promise<void>;
}

export type CompensationResult = { kind: 'done' } | { kind: 'park'; wakeAt: number } | { kind: 'failed'; error: SerializedError } | { kind: 'aborted' };

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
  /** CreatedAt + the workflow's `timeout`; null without one. */
  deadline?: number | null;
  /** A fenced write matched no row: another replica owns the instance now. */
  onLeaseLost: () => void;
  /** A crash reached the activation: as far as the instance is concerned, this replica is dead. */
  onCrash: (err: unknown) => void;
  /** A journal row failed to commit for a reason other than a lost lease or a crash: nothing of this activation may commit after it. */
  onJournalFailed: (err: unknown, what?: string) => void;
  /** 'collect': only operations with a recorded outcome replay, registering their compensations; nothing else runs (D6). */
  mode?: 'run' | 'collect';
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
/** A collecting replay parks on whatever has no recorded outcome; the engine never writes this park. */
const COLLECT_PARK: Park = { status: 'running', wakeAt: null, waitingFor: null };

/** The uuid v5 namespace of `ctx.uuid()`; changing it changes every id a replay derives. */
export const WORKFLOW_NAMESPACE = '6f1c2a7e-3b9d-4e84-9a0c-2d4e8b7f1a63';

/** The resource is kept in its JSON form: the first run hands the authorizer what every replay reads back. */
function waitMeta(name: string, opts: WaitForEventOptions, startedAt: number): StepMeta {
  if (opts.permission !== undefined && (typeof opts.permission !== 'string' || opts.permission.length === 0)) throw new InvalidArgument(`waitForEvent('${name}') permission must be a non-empty string`);
  const resource = opts.resource === undefined ? undefined : safeStringify(opts.resource);
  if (opts.resource !== undefined && resource === undefined) throw new InvalidArgument(`waitForEvent('${name}') resource must be representable as JSON`);
  return {
    timeoutAt: opts.timeout === undefined ? null : startedAt + parseDuration(opts.timeout, `waitForEvent('${name}') timeout`),
    ...(opts.permission !== undefined ? { permission: opts.permission } : {}),
    ...(resource !== undefined ? { resource: JSON.parse(resource) as Record<string, unknown> } : {}),
  };
}

/**
 * @internal
 * Parallel operations parked at once: the instance wakes at the earliest wake time or on a signal for any of its
 * waits (`'*'` when they wait for different names), and replays the others.
 */
export function mergePark(a: Park, b: Park): Park {
  const wakes = [a.wakeAt, b.wakeAt].filter((w): w is number => w !== null);
  const names = [a.waitingFor, b.waitingFor].filter((n): n is string => n !== null);
  const waitingFor = names.length === 0 ? null : names.every((n) => n === names[0]) ? names[0] : '*';
  const earlier = (a.wakeAt ?? Infinity) <= (b.wakeAt ?? Infinity) ? a : b;
  return { status: waitingFor === null ? earlier.status : 'waiting', wakeAt: wakes.length === 0 ? null : Math.min(...wakes), waitingFor };
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
  /** Registered by the succeeded steps this activation ran or replayed. */
  public readonly compensations: RegisteredCompensation[] = [];

  protected seq = 0;
  protected occurrences = new Map<string, number>();
  protected inflight = new Set<Promise<unknown>>();
  /** Blocking operations that cannot finish in this activation; their promises stay pending until the park or the end. */
  protected parked: ((err: unknown) => void)[] = [];
  protected pendingPark: Park | null = null;
  protected parkCheck = false;
  /** `run()` settled or the activation is draining: its outcome stands, nothing parks, journals or interrupts any more. */
  protected closed = false;
  protected parkDecided!: () => void;
  /** Resolves once the activation parks. */
  public readonly suspended = new Promise<void>((resolve) => {
    this.parkDecided = resolve;
  });
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

  public get mode(): 'run' | 'collect' {
    return this.init.mode ?? 'run';
  }

  public get deadline(): number | null {
    return this.init.deadline ?? null;
  }

  /** The instance passed its `timeout`: every later operation throws and the engine fails it. */
  public expire(): WorkflowTimeout {
    const error = new WorkflowTimeout(this.workflow, this.init.definition.timeoutMs ?? 0);
    this.interrupt({ kind: 'timeout', error });
    return error;
  }

  /** Async so an invalid policy rejects; the key is still taken synchronously at the call, so parallel calls keep their order. */
  public async step<T>(name: string, fn: StepFn<T>, opts: WorkflowStepOptions<T> = {}): Promise<T> {
    // before any body runs: an invalid policy would otherwise surface only when the step first fails
    const retry = this.retryPolicy(opts.retry);
    return this.begin('step', name, (op) => this.runStep(op, fn, opts, retry));
  }

  public sleep(duration: string | number, name = 'sleep'): Promise<void> {
    return this.begin('sleep', name, (op) => this.runSleep(op, () => this.init.clock.now() + parseDuration(duration, `sleep('${name}')`)));
  }

  public sleepUntil(at: number | Date, name = 'sleep'): Promise<void> {
    return this.begin('sleep', name, (op) =>
      this.runSleep(op, () => {
        const ms = at instanceof Date ? at.getTime() : at;
        if (!Number.isFinite(ms)) throw new InvalidArgument(`sleepUntil('${name}') needs a valid instant`);
        return ms;
      }),
    );
  }

  public waitForEvent<T = unknown>(name: string, opts: WaitForEventOptions = {}): Promise<WorkflowEvent<T> | undefined> {
    const problem = eventNameProblem(name);
    if (problem) return Promise.reject(new InvalidArgument(`waitForEvent name ${problem}`));
    return this.begin('wait', name, (op) => this.runWait<T>(op, opts));
  }

  public emit(_name: string, _message: QueueEvent | QueueJob): Promise<void> {
    return Promise.reject(new NotSupported('ctx.emit()'));
  }

  public now(): number {
    const op = this.marker('now');
    if (this.init.journal.get(op.key)?.Status === 'succeeded') return this.init.journal.value(op.key) as number;
    const value = this.init.clock.now();
    this.recordMarker(op, value);
    return value;
  }

  /** Derived, not random: a run that repeats before its marker commits produces the same id. */
  public uuid(): string {
    const op = this.marker('uuid');
    const value = uuidv5(`${this.instanceId}:${op.key}`, WORKFLOW_NAMESPACE);
    if (!this.init.journal.get(op.key)) this.recordMarker(op, value);
    return value;
  }

  public random(): number {
    const op = this.marker('random');
    const value = unitHash(`${this.instanceId}:${op.key}`);
    if (!this.init.journal.get(op.key)) this.recordMarker(op, value);
    return value;
  }

  public fail(reason: string, details?: unknown): never {
    const error = new WorkflowFailure(reason, details);
    this.interrupt({ kind: 'fail', error });
    throw error;
  }

  /** The engine hands over `run()`: once it settled, its outcome stands; no park (lazy or retry) overrides it. */
  public observe(run: Promise<unknown>): void {
    const settled = (): void => {
      this.closed = true;
    };
    void run.then(settled, settled);
  }

  /** Waits for every operation still in flight, e.g. the sibling of a suspended `Promise.all`; parked ones are abandoned. */
  public async drain(): Promise<void> {
    this.closed = true;
    while (this.inflight.size > 0) {
      // an operation may reach park() only now; park() rejects it at once once the activation is closed
      this.abandonParked();
      await Promise.allSettled([...this.inflight]);
    }
    await this.writes;
  }

  /** `next()` runs synchronously at the call, so parallel operations take their keys in call order. */
  protected async begin<T>(kind: StepKind, name: string, run: (op: Op) => Promise<T>): Promise<T> {
    const op = this.next(kind, name);
    // a branch stops at its first operation without an outcome, the others go on replaying; the park ends the replay
    return this.track(this.collecting(op) ? this.park(COLLECT_PARK) : run(op));
  }

  /** Markers return synchronously, so one without a recorded value ends its branch instead of parking it. */
  protected marker(name: 'now' | 'uuid' | 'random'): Op {
    const op = this.next('marker', name);
    if (this.collecting(op)) throw new WorkflowSuspended() as unknown;
    return op;
  }

  protected collecting(op: Op): boolean {
    if (this.init.mode !== 'collect') return false;
    const status = this.init.journal.get(op.key)?.Status;
    return status !== 'succeeded' && status !== 'failed';
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
    // a race's loser that catches its abandonment cannot journal more work into a run that has ended
    if (this.closed) throw new WorkflowSuspended() as unknown;
    const i = this.interruption;
    // typed unknown: WorkflowSuspended is deliberately not an Error (see its class)
    if (i?.kind === 'park') throw new WorkflowSuspended() as unknown;
    if (i) throw i.error;
    if (this.signal.aborted) throw new WorkflowAborted(this.abortReason());
    if (this.deadline !== null && this.init.clock.now() >= this.deadline) throw this.expire();
  }

  protected interrupt(requested: Interruption): void {
    if (this.closed) return;
    const next: Interruption = requested.kind === 'park' && this.pendingPark ? { kind: 'park', park: mergePark(this.pendingPark, requested.park) } : requested;
    const cur = this.interruption;
    if (!cur) this.interruption = next;
    else if (cur.kind === 'park' && next.kind === 'park') this.interruption = { kind: 'park', park: mergePark(cur.park, next.park) };
    else if (PRIORITY[next.kind] > PRIORITY[cur.kind]) this.interruption = next;
    const now = this.interruption;
    if (now) this.gate.abort(now.kind === 'park' ? new WorkflowSuspended() : now.error);
    if (now?.kind === 'park') this.parkDecided();
    this.abandonParked();
  }

  protected track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const untrack = (): void => {
      this.inflight.delete(p);
      if (this.parked.length > 0) this.checkPark();
    };
    void p.then(untrack, untrack);
    return p;
  }

  /** Records the park and leaves the operation pending: a sibling may still finish `run()` or need more work first. */
  protected async park(p: Park): Promise<never> {
    if (this.closed || this.interruption) throw new WorkflowSuspended() as unknown;
    this.pendingPark = this.pendingPark ? mergePark(this.pendingPark, p) : p;
    return new Promise<never>((_resolve, reject) => {
      this.parked.push(reject);
      this.checkPark();
    });
  }

  /**
   * Parks once `run()` has not settled and every operation in flight is parked, after the write queue drained and a
   * macrotask passed without a new durable call. A park never changes a result: whatever it cuts off (a non-durable
   * await, a branch that had not reached its next call) replays in the next activation, which can be as late as the
   * park's wake-up.
   */
  protected checkPark(): void {
    if (this.parkCheck) return;
    this.parkCheck = true;
    void this.parkWhenIdle();
  }

  protected async parkWhenIdle(): Promise<void> {
    const seq = this.seq;
    await this.writes;
    await new Promise<void>((resolve) => nextMacrotask(resolve));
    this.parkCheck = false;
    if (this.closed || this.interruption || this.parked.length === 0) return;
    if (this.seq !== seq) this.checkPark();
    else if (this.inflight.size === this.parked.length && this.pendingPark) this.interrupt({ kind: 'park', park: this.pendingPark });
  }

  protected abandonParked(): void {
    for (const reject of this.parked.splice(0)) reject(new WorkflowSuspended());
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
  protected abandonJournal(err: unknown, what?: string): void {
    if (this.journalFailed) return;
    this.journalFailed = true;
    this.gate.abort(new WorkflowAborted('journal-failed'));
    this.init.onJournalFailed(err, what);
  }

  /** Amendment 20: a journal row that failed for any reason but a crash or a lost lease abandons the activation. */
  protected journalWriteFailed(err: unknown, what?: string): unknown {
    if (isCrash(err)) this.crash(err);
    if (isCrash(err) || err instanceof WorkflowAborted) return err;
    this.abandonJournal(err, what);
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

  protected async runStep<T>(op: Op, fn: StepFn<T>, opts: WorkflowStepOptions<T>, retry: NormalizedRetry): Promise<T> {
    const { journal } = this.init;
    const rec = journal.get(op.key);
    if (rec?.Status === 'succeeded' || rec?.Status === 'failed') {
      // before the gate releases it: the step ran even if this activation ends before run() sees its result
      if (rec.Status === 'succeeded') this.registerCompensation(op, journal.value(op.key) as T, opts, retry);
      await this.released(op);
      if (rec.Status === 'succeeded') return journal.value(op.key) as T;
      throw new WorkflowStepFailed(op.name, rec.Error ?? { name: 'Error', message: 'step failed' });
    }
    const wakeAt = rec?.Status === 'retrying' ? rec.Meta?.wakeAt : undefined;
    // a parallel step woke the instance early and this one waits out its own backoff
    if (wakeAt !== undefined && this.init.clock.now() < wakeAt) return this.park({ status: 'running', wakeAt, waitingFor: null });
    return this.runLive(op, fn, opts, rec, retry);
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

  protected async runLive<T>(op: Op, fn: StepFn<T>, opts: WorkflowStepOptions<T>, rec: StepRow | undefined, retry: NormalizedRetry): Promise<T> {
    const { clock } = this.init;
    const attempt = (rec?.Attempt ?? 0) + 1;
    const startedAt = clock.now();
    let value: T;
    try {
      value = await this.execute(op, fn, attempt, startedAt, opts);
    } catch (err) {
      throw await this.stepFailed(op, err, attempt, startedAt, retry);
    }
    this.registerCompensation(op, value, opts, retry);
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
      const before = this.init.journal.get(op.key);
      let journaled = false;
      try {
        return await this.init.store.driver.transaction(async () => {
          const value = await call();
          await this.fault('workflow.after-step-fn', op.key);
          const kept = await journalIt(value);
          journaled = true;
          return kept;
        });
      } catch (err) {
        if (!journaled) throw err;
        // the body succeeded and its row was written, then COMMIT failed: a journal failure, not the step's
        this.init.journal.restore(op.key, before);
        throw this.journalWriteFailed(err);
      }
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
  protected async stepFailed(op: Op, err: unknown, attempt: number, startedAt: number, retry: NormalizedRetry): Promise<unknown> {
    if (this.crashed || isCrash(err)) {
      this.crash(err);
      return err;
    }
    if (err instanceof LeaseLostError || err instanceof WorkflowAborted || this.signal.aborted) return new WorkflowAborted(this.abortReason());
    const error = serializeError(err, op.name);
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
    return this.park({ status: 'running', wakeAt, waitingFor: null });
  }

  /** The wake time is computed once, on the database clock; every replay reads it back from the row. */
  protected async runSleep(op: Op, target: () => number): Promise<void> {
    const { journal, clock } = this.init;
    const rec = journal.get(op.key);
    if (rec?.Status === 'succeeded') return this.released(op);
    const wakeAt = rec?.Meta?.wakeAt ?? target();
    const startedAt = clock.now();
    if (clock.now() >= wakeAt) {
      await this.record(op, { status: 'succeeded', attempt: 1, startedAt, meta: { wakeAt }, finished: true });
      return this.gate.live(op.order);
    }
    if (!rec) {
      await this.record(op, { status: 'pending', attempt: 1, startedAt, meta: { wakeAt } });
      await this.fault('workflow.after-journal', op.key);
    }
    return this.park({ status: 'sleeping', wakeAt, waitingFor: null });
  }

  /**
   * Markers are synchronous: the row is queued, and every later journal write of this activation commits after it.
   * A failed write abandons the activation (D3): `run()` already holds a value a replay would compute anew.
   */
  protected recordMarker(op: Op, value: unknown): void {
    const startedAt = this.init.clock.now();
    void this.track(
      this.enqueueWrite(() => this.saveStep(op, { status: 'succeeded', attempt: 1, startedAt, result: { value }, finished: true })).catch((err: unknown) => {
        this.journalWriteFailed(err);
      }),
    );
  }

  /** The first run records the timeout and permission; replays honour the recorded ones, whatever `opts` say now. */
  protected async runWait<T>(op: Op, opts: WaitForEventOptions): Promise<WorkflowEvent<T> | undefined> {
    const { journal, clock } = this.init;
    const rec = journal.get(op.key);
    if (rec?.Status === 'succeeded') {
      await this.released(op);
      return (journal.value(op.key) ?? undefined) as WorkflowEvent<T> | undefined;
    }
    const startedAt = clock.now();
    const meta = rec?.Meta ?? waitMeta(op.name, opts, startedAt);
    if (!rec) {
      await this.record(op, { status: 'pending', attempt: 1, startedAt, meta });
      await this.fault('workflow.after-journal', op.key);
    }
    const event = await this.consume<T>(op, meta, startedAt);
    const timeoutAt = meta.timeoutAt ?? null;
    if (event === undefined && timeoutAt !== null && clock.now() >= timeoutAt) await this.record(op, { status: 'succeeded', attempt: 1, startedAt, finished: true });
    // a wait that loses a race stays pending and consumes events of its name on later replays
    else if (event === undefined) return this.park({ status: 'waiting', wakeAt: timeoutAt, waitingFor: op.name });
    await this.gate.live(op.order);
    return event;
  }

  /**
   * Oldest pending event first (insert order); the conditional consume under the fence lets only one activation take an event. A
   * permissioned wait asks the SignalAuthorizer at consumption time and rejects what it denies (D7).
   */
  protected async consume<T>(op: Op, meta: StepMeta, startedAt: number): Promise<WorkflowEvent<T> | undefined> {
    const pending = await WorkflowEventModel.where({ InstanceId: this.instanceId, Name: op.name, State: 'pending' }).onPrimary().orderBy('Id');
    for (const e of pending) {
      if (meta.permission !== undefined && !(await this.authorized(e, meta.permission, meta.resource))) {
        await this.rejectEvent(e.Id);
        continue;
      }
      const event: WorkflowEvent<T> = { name: e.Name, payload: e.Payload as T, receivedAt: Number(e.ReceivedAt), ...(e.Principal ? { principal: e.Principal } : {}) };
      const take = async (): Promise<boolean> => (await WorkflowEventModel.update({ State: 'consumed', ConsumedByKey: op.key }).where({ Id: e.Id, State: 'pending' })).RowsAffected === 1;
      if (await this.record(op, { status: 'succeeded', attempt: 1, startedAt, result: { value: event }, finished: true }, take)) return event;
    }
    return undefined;
  }

  /** An authorizer that fails decides nothing: the event stays pending and a later activation asks again. Only `true` allows. */
  protected async authorized(e: WorkflowEventModel, permission: string, resource: Record<string, unknown> | undefined): Promise<boolean> {
    try {
      const authorizer = await DI.resolve(SignalAuthorizer);
      return (await authorizer.authorize(e.Principal ?? undefined, permission, resource, { instanceId: this.instanceId, workflow: this.workflow, event: e.Name })) === true;
    } catch (err) {
      throw this.journalWriteFailed(err, `the signal authorizer failed for event '${e.Name}'`);
    }
  }

  /** Fenced and conditional on 'pending', like a consume. */
  protected rejectEvent(eventId: number | string): Promise<unknown> {
    const { store, clock, epoch } = this.init;
    const reject = async (): Promise<unknown> => await WorkflowEventModel.update({ State: 'rejected' }).where({ Id: eventId, State: 'pending' });
    return this.enqueueWrite(() => this.guarded(() => store.fenced(this.instanceId, epoch, clock.now(), reject))).catch((err: unknown) => {
      throw this.journalWriteFailed(err);
    });
  }

  /** The closure is rebuilt on every replay, so a compensation is registered by the replayed step, not stored. */
  protected registerCompensation<T>(op: Op, value: T, opts: WorkflowStepOptions<T>, retry: NormalizedRetry): void {
    const compensate = opts.compensate;
    if (!compensate) return;
    const order = op.order ?? this.init.journal.get(op.key)?.Meta?.order ?? 0;
    this.compensations.push({ key: op.key, name: op.name, order, retry, run: (ctx) => compensate(value, ctx) });
  }

  /** Exactly the fields of `CompensationContext`: no `step`, `emit` or markers inside a compensation (D6). */
  protected compensationContext(signal: AbortSignal): CompensationContext {
    return { instanceId: this.instanceId, workflow: this.workflow, version: this.version, input: this.input, signal, log: this.log };
  }

  /**
   * Runs the registered compensations newest first, each journaled as `compensate:<step>#<occurrence>` and retried
   * under its step's policy. Called by the engine after `run()` settled, under the activation's lease.
   */
  public async compensate(signal: AbortSignal): Promise<CompensationResult> {
    signal.addEventListener(
      'abort',
      () => {
        if (signal.reason === 'crashed') this.crashed = true;
      },
      { once: true },
    );
    // stable: rows without Meta.order (older journals) keep reverse registration order
    const pending = [...this.compensations].reverse().sort((a, b) => b.order - a.order);
    for (const [i, c] of pending.entries()) {
      const op: Op = { kind: 'compensate', name: c.name, key: `compensate:${c.key.slice(c.key.indexOf(':') + 1)}`, seq: COMPENSATION_SEQ_BASE + i, after: this.gate.delivered };
      const rec = this.init.journal.get(op.key);
      if (rec?.Status === 'succeeded') continue;
      if (rec?.Status === 'failed') return { kind: 'failed', error: rec.Error ?? { name: 'Error', message: 'compensation failed', step: c.name } };
      const wakeAt = rec?.Status === 'retrying' ? rec.Meta?.wakeAt : undefined;
      if (wakeAt !== undefined && this.init.clock.now() < wakeAt) return { kind: 'park', wakeAt };
      const result = await this.runCompensation(op, c, (rec?.Attempt ?? 0) + 1, signal);
      if (result) return result;
    }
    return { kind: 'done' };
  }

  /** `null`: this compensation succeeded, go on with the next one. */
  protected async runCompensation(op: Op, c: RegisteredCompensation, attempt: number, signal: AbortSignal): Promise<CompensationResult | null> {
    if (signal.aborted || this.crashed) return { kind: 'aborted' };
    const startedAt = this.init.clock.now();
    let failure: { err: unknown } | undefined;
    try {
      await stepScope.run(op.name, () => Promise.resolve().then(() => c.run(this.compensationContext(signal))));
    } catch (err) {
      failure = { err };
    }
    if (failure && (this.crashed || isCrash(failure.err))) {
      this.crash(failure.err);
      return { kind: 'aborted' };
    }
    if (failure && signal.aborted) return { kind: 'aborted' };
    try {
      return await this.journalCompensation(op, c, attempt, startedAt, failure);
    } catch (err) {
      // the compensation ran but its row is missing: the pass resumes at it on the next activation
      this.journalWriteFailed(err, `the journal row of '${op.key}' could not be written`);
      return { kind: 'aborted' };
    }
  }

  protected async journalCompensation(op: Op, c: RegisteredCompensation, attempt: number, startedAt: number, failure: { err: unknown } | undefined): Promise<CompensationResult | null> {
    if (!failure) {
      await this.saveStep(op, { status: 'succeeded', attempt, startedAt, meta: null, finished: true });
      await this.fault('workflow.after-journal', op.key);
      return null;
    }
    const error = serializeError(failure.err, op.name);
    const again = isRetryable(c.retry, failure.err) && attempt < c.retry.attempts;
    const wakeAt = again ? this.init.clock.now() + computeBackoff(c.retry, attempt, () => unitHash(`${this.instanceId}:${op.key}:${attempt}`)) : null;
    await this.saveStep(op, { status: again ? 'retrying' : 'failed', attempt, startedAt, error, meta: wakeAt === null ? null : { wakeAt }, finished: true });
    return wakeAt === null ? { kind: 'failed', error } : { kind: 'park', wakeAt };
  }

  /** A blocking operation's journal row, queued behind earlier writes; a failed write is not the operation's failure. */
  protected record(op: Op, s: Save, claim?: () => Promise<boolean>): Promise<StepRow | null> {
    return this.enqueueWrite(() => this.saveStep(op, s, claim)).catch((err: unknown) => {
      throw this.journalWriteFailed(err);
    });
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

  /** `claim` runs under the fence before the row: when it returns false nothing is journaled and null comes back. */
  protected async saveStep(op: Op, s: Save, claim?: () => Promise<boolean>): Promise<StepRow | null> {
    if (this.crashed) throw new WorkflowAborted('crashed');
    if (this.journalFailed) throw new WorkflowAborted('journal-failed');
    await this.fault('workflow.before-journal', op.key);
    const { store, journal, clock, epoch } = this.init;
    if (journal.causal && !Number.isInteger(op.after)) throw new InvalidOperation(`'${op.key}' has no Meta.after: the journal would lose its causality metadata`);
    const final = s.status === 'succeeded' || s.status === 'failed';
    const kept = s.meta === undefined ? journal.get(op.key)?.Meta : s.meta;
    const row = await this.guarded(() => {
      const now = clock.now();
      return store.fenced(this.instanceId, epoch, now, async () => {
        if (claim && !(await claim())) return null;
        // Taken under the row lock the fence UPDATE holds until commit, so the order is the commit order.
        const meta: StepMeta = { ...kept, after: op.after, ...(final ? { order: journal.nextOrder() } : {}) };
        op.order = meta.order;
        return store.saveStep(journal.get(op.key), this.stepWrite(op, { ...s, meta }, now));
      });
    });
    if (row) journal.record(row);
    return row;
  }
}
