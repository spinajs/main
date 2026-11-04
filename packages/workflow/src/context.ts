import { AsyncLocalStorage } from 'node:async_hooks';
import type { DbClock, FaultInjector, FaultPointName } from '@spinajs/durable';
import { InvalidArgument, NotSupported } from '@spinajs/exceptions';
import type { Log } from '@spinajs/log-common';
import type { QueueEvent, QueueJob } from '@spinajs/queue';
import type { SerializedError, StepKind, StepMeta, StepStatus, WaitForEventOptions, WorkflowContext, WorkflowEvent, WorkflowStepOptions } from './contract.js';
import {
  isCrash,
  LeaseLostError,
  NonDeterminismError,
  serializeError,
  WorkflowAborted,
  WorkflowFailure,
  WorkflowNestingError,
  WorkflowStepFailed,
  WorkflowStepResultTooLarge,
  WorkflowSuspended,
  type AbortReason,
} from './errors.js';
import { identifierProblem } from './identifier.js';
import type { Journal, StepRow } from './journal.js';
import { safeStringify } from './json.js';
import type { WorkflowInstanceModel } from './models/WorkflowInstanceModel.js';
import type { RegisteredWorkflow } from './registry.js';
import type { InstanceStore, StepWrite } from './store.js';
import type { WorkflowConfig } from './workflow-config.js';

export interface Park {
  status: 'running' | 'sleeping' | 'waiting';
  wakeAt: number | null;
  waitingFor: string | null;
}

export type Interruption =
  | { kind: 'park'; park: Park }
  | { kind: 'fail'; error: WorkflowFailure }
  | { kind: 'timeout'; error: Error }
  | { kind: 'nondeterminism'; error: NonDeterminismError };

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
  /** A fault point threw a crash: as far as the instance is concerned, this replica is dead. */
  onCrash: () => void;
  /** A journal row failed to commit for a reason other than a lost lease or a crash: nothing of this activation may commit after it. */
  onJournalFailed: (err: unknown) => void;
}

export interface Op {
  kind: StepKind;
  name: string;
  key: string;
  seq: number;
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
  protected journalFailed = false;

  protected seq = 0;
  protected occurrences = new Map<string, number>();
  protected inflight = new Set<Promise<unknown>>();
  /** Journal writes of non-transactional operations, in call order: a marker never commits after a later step. */
  protected writes: Promise<unknown> = Promise.resolve();

  constructor(protected readonly init: ActivationInit) {
    const i = init.instance;
    this.instanceId = i.Id;
    this.workflow = i.Workflow;
    this.version = i.Version;
    this.input = i.Input ?? null;
    this.signal = init.signal;
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

  protected begin<T>(kind: StepKind, name: string, run: (op: Op) => Promise<T>): Promise<T> {
    let op: Op;
    try {
      op = this.next(kind, name);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.track(run(op));
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
    const op: Op = { kind, name, key: `${base}#${occurrence}`, seq: ++this.seq };
    try {
      this.init.journal.check(op.seq, op.key);
    } catch (err) {
      this.interrupt({ kind: 'nondeterminism', error: err as NonDeterminismError });
      throw err;
    }
    return op;
  }

  protected assertLive(): void {
    if (this.crashed) throw new WorkflowAborted('crashed');
    if (this.journalFailed) throw new WorkflowAborted('journal-failed');
    const i = this.interruption;
    if (i?.kind === 'park') throw new WorkflowSuspended();
    if (i) throw i.error;
    if (this.signal.aborted) throw new WorkflowAborted(this.abortReason());
  }

  protected interrupt(next: Interruption): void {
    const cur = this.interruption;
    if (!cur) this.interruption = next;
    else if (cur.kind === 'park' && next.kind === 'park') this.interruption = { kind: 'park', park: earlierPark(cur.park, next.park) };
    else if (PRIORITY[next.kind] > PRIORITY[cur.kind]) this.interruption = next;
  }

  protected track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = (): void => {
      this.inflight.delete(p);
    };
    p.then(done, done);
    return p;
  }

  protected enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const p = this.writes.then(work);
    this.writes = p.catch(() => undefined);
    return p;
  }

  protected abortReason(): AbortReason {
    if (this.crashed) return 'crashed';
    return (this.signal.reason as AbortReason | undefined) ?? 'lease-lost';
  }

  protected crash(): void {
    if (this.crashed) return;
    this.crashed = true;
    this.init.onCrash();
  }

  /** A journal write that failed leaves a hole a replay would fill differently (D3): no later write of this activation may commit. */
  protected abandonJournal(err: unknown): void {
    if (this.journalFailed) return;
    this.journalFailed = true;
    this.init.onJournalFailed(err);
  }

  protected async fault(name: FaultPointName, key: string): Promise<void> {
    try {
      await this.init.faults.point(name, { instanceId: this.instanceId, key });
    } catch (err) {
      if (isCrash(err)) this.crash();
      throw err;
    }
  }

  protected async runStep<T>(op: Op, fn: StepFn<T>, opts: WorkflowStepOptions<T>): Promise<T> {
    const { journal, clock } = this.init;
    const rec = journal.get(op.key);
    if (rec?.Status === 'succeeded') return journal.value(op.key) as T;
    if (rec?.Status === 'failed') throw new WorkflowStepFailed(op.name, rec.Error ?? { name: 'Error', message: 'step failed' });
    const attempt = (rec?.Attempt ?? 0) + 1;
    const startedAt = clock.now();
    let value: T;
    try {
      value = await this.execute(op, fn, attempt, startedAt, opts);
    } catch (err) {
      throw await this.stepFailed(op, err, attempt, startedAt, opts);
    }
    await this.fault('workflow.after-journal', op.key);
    return value;
  }

  protected async execute<T>(op: Op, fn: StepFn<T>, attempt: number, startedAt: number, opts: WorkflowStepOptions<T>): Promise<T> {
    const call = (): Promise<T> => stepScope.run(op.name, () => Promise.resolve().then(() => fn({ signal: this.signal, attempt })));
    const journalIt = async (value: T): Promise<T> => {
      const kept = opts.persistResult === false ? undefined : this.checkResult(op, value);
      await this.saveStep(op, { status: 'succeeded', attempt, startedAt, result: kept === undefined ? undefined : { value: kept }, meta: opts.compensate ? { compensate: true } : null, finished: true });
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

  /** Returns what the step throws to `run()`. */
  protected async stepFailed<T>(op: Op, err: unknown, attempt: number, startedAt: number, _opts: WorkflowStepOptions<T>): Promise<unknown> {
    if (this.crashed || isCrash(err)) {
      this.crash();
      return err;
    }
    if (err instanceof LeaseLostError || err instanceof WorkflowAborted || this.signal.aborted) return new WorkflowAborted(this.abortReason());
    const error = serializeError(err, op.name);
    try {
      await this.enqueueWrite(() => this.saveStep(op, { status: 'failed', attempt, startedAt, error, finished: true }));
    } catch (writeErr) {
      return isCrash(writeErr) || writeErr instanceof WorkflowAborted ? new WorkflowAborted(this.abortReason()) : writeErr;
    }
    return new WorkflowStepFailed(op.name, error, err);
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
    const row = await this.guarded(() => {
      const now = clock.now();
      return store.fenced(this.instanceId, epoch, now, () => store.saveStep(journal.get(op.key), this.stepWrite(op, s, now)));
    });
    journal.record(row);
    return row;
  }
}
