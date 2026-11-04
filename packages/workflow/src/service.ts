import { Autoinject, DI, Injectable, Singleton, type Constructor } from '@spinajs/di';
import { DbClock, quoteFor, sqlDialect, type RawSqlDriver } from '@spinajs/durable';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { UniqueViolation } from '@spinajs/orm';
import { v4 as uuidv4 } from 'uuid';
import { isTerminal, type StartOptions, type WorkflowInstanceView, type WorkflowStatus } from './contract.js';
import { WorkflowIdConflict, WorkflowNotFound, WorkflowStartConflict } from './errors.js';
import { missingVersions } from './health.js';
import { identifierProblem } from './identifier.js';
import { safeStringify } from './json.js';
import { WorkflowEventModel } from './models/WorkflowEventModel.js';
import { WorkflowInstanceModel } from './models/WorkflowInstanceModel.js';
import { WorkflowStepModel } from './models/WorkflowStepModel.js';
import { WorkflowRegistry, type WorkflowDefinition } from './registry.js';
import { selectRows, workflowDriver } from './sql.js';

export interface SignalOptions {
  principal?: string;
  dedupKey?: string;
}

export interface ListFilter {
  workflow?: string;
  status?: WorkflowStatus[];
  limit?: number;
  /** The last id of the previous page. */
  after?: string;
}

export interface MissingVersion {
  workflow: string;
  version: number;
  instances: number;
}

export abstract class WorkflowService {
  /** Idempotent on `opts.id`. */
  public abstract start<TInput>(workflow: string | Constructor<WorkflowDefinition<TInput>>, input: TInput, opts?: StartOptions): Promise<{ id: string; created: boolean }>;
  public abstract signal(instanceId: string, name: string, payload: unknown, opts?: SignalOptions): Promise<{ accepted: boolean }>;
  public abstract cancel(instanceId: string, reason?: string): Promise<void>;
  /** failed → running, from the failed step. */
  public abstract retry(instanceId: string): Promise<void>;
  public abstract get(instanceId: string): Promise<WorkflowInstanceView | undefined>;
  public abstract list(filter: ListFilter): Promise<WorkflowInstanceView[]>;
  public abstract health(): Promise<{ missingVersions: MissingVersion[] }>;
}

export function toView(r: WorkflowInstanceModel): WorkflowInstanceView {
  return {
    id: r.Id,
    workflow: r.Workflow,
    version: r.Version,
    status: r.Status,
    reason: r.Reason ?? null,
    input: r.Input ?? null,
    result: r.Result ?? null,
    error: r.Error ?? null,
    wakeAt: r.WakeAt ?? null,
    waitingFor: r.WaitingFor ?? null,
    attempt: r.Attempt,
    cancelRequested: !!r.CancelRequested,
    createdAt: r.CreatedAt,
    updatedAt: r.UpdatedAt,
    finishedAt: r.FinishedAt ?? null,
  };
}

const MAX_ID = 128;
const MAX_SIGNAL_NAME = 128;
const MAX_DEDUP_KEY = 128;
const MAX_PRINCIPAL = 200;
const MAX_REASON = 64;
const CANCELLABLE: WorkflowStatus[] = ['running', 'sleeping', 'waiting'];
const MAX_PAGE = 500;
const DEFAULT_PAGE = 50;
const RETRIED_KINDS = new Set(['step', 'emit']);

/**
 * Failed step and emit rows that no later recorded call saw. A failure the workflow caught and handled was delivered
 * before a recorded call was made (`Meta.after >= order`); it stays failed and replays as the recorded rejection.
 */
function unobservedFailures(rows: WorkflowStepModel[]): WorkflowStepModel[] {
  const seen = rows.reduce((max, r) => (r.Kind === 'compensate' ? max : Math.max(max, r.Meta?.after ?? -1)), -1);
  return rows.filter((r) => r.Status === 'failed' && RETRIED_KINDS.has(r.Kind) && !(r.Meta?.order !== undefined && seen >= r.Meta.order));
}

function jsonText(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  const text = safeStringify(value);
  if (text === undefined) throw new InvalidArgument(`${what} must be representable as JSON`);
  return text;
}

function checkSignal(name: string, opts: SignalOptions): void {
  const problem = identifierProblem(name, MAX_SIGNAL_NAME);
  if (problem) throw new InvalidArgument(`signal name ${problem}`);
  const dedup = opts.dedupKey === undefined ? undefined : identifierProblem(opts.dedupKey, MAX_DEDUP_KEY);
  if (dedup) throw new InvalidArgument(`signal dedupKey ${dedup}`);
  // UTF-16 units, never fewer than the code points varchar(200) counts
  if (opts.principal !== undefined && opts.principal.length > MAX_PRINCIPAL) throw new InvalidArgument(`signal principal must be at most ${MAX_PRINCIPAL} characters`);
}

@Singleton()
@Injectable(WorkflowService)
export class DefaultWorkflowService extends WorkflowService {
  @Autoinject(DbClock)
  protected Clock: DbClock;

  protected synced?: Promise<number>;

  public async start<TInput>(workflow: string | Constructor<WorkflowDefinition<TInput>>, input: TInput, opts: StartOptions = {}): Promise<{ id: string; created: boolean }> {
    const def = (await this.registry()).resolveForStart(workflow, opts.version);
    const id = opts.id ?? uuidv4();
    const problem = identifierProblem(id, MAX_ID);
    if (problem) throw new InvalidArgument(`workflow instance id ${problem}`);
    const inputText = jsonText(input, 'workflow input');
    const now = await this.now();
    const driver = await workflowDriver();
    try {
      // A savepoint inside the caller's transaction: on Postgres a failed INSERT would abort all of it.
      await driver.transaction(() =>
        WorkflowInstanceModel.create({
          Id: id,
          Workflow: def.name,
          Version: def.version,
          Status: 'running',
          Reason: null,
          Input: inputText,
          Result: null,
          Error: null,
          WakeAt: null,
          WaitingFor: null,
          Attempt: 0,
          ClaimedBy: null,
          ClaimedUntil: null,
          ClaimEpoch: 0,
          CancelRequested: false,
          CreatedAt: now,
          UpdatedAt: now,
          FinishedAt: null,
        }),
      );
      return { id, created: true };
    } catch (err) {
      const existing = await this.existingWorkflow(driver, id);
      if (existing === undefined) throw err instanceof UniqueViolation ? new WorkflowStartConflict(id) : err;
      if (existing !== def.name) throw new WorkflowIdConflict(id, existing, def.name);
      return { id, created: false };
    }
  }

  public async get(instanceId: string): Promise<WorkflowInstanceView | undefined> {
    const row = await WorkflowInstanceModel.where('Id', instanceId).onPrimary().first();
    return row ? toView(row) : undefined;
  }

  /** D7: buffered until a wait consumes it; the conditional flip wakes an instance that waits for exactly this name. */
  public async signal(instanceId: string, name: string, payload: unknown, opts: SignalOptions = {}): Promise<{ accepted: boolean }> {
    checkSignal(name, opts);
    const payloadText = jsonText(payload, 'signal payload');
    // an empty principal is no principal: the authorizer sees `undefined` either way
    const principal = opts.principal === undefined || opts.principal === '' ? null : opts.principal;
    const now = await this.now();
    const driver = await workflowDriver();
    return driver.transaction(async () => {
      const status = await this.lockedStatus(driver, instanceId);
      if (status === undefined) throw new WorkflowNotFound(instanceId);
      if (isTerminal(status)) return { accepted: false };
      try {
        // a savepoint: on Postgres a failed INSERT would abort the whole transaction
        await driver.transaction(() =>
          WorkflowEventModel.create({
            InstanceId: instanceId,
            Name: name,
            Payload: payloadText,
            Principal: principal,
            DedupKey: opts.dedupKey ?? null,
            State: 'pending',
            ConsumedByKey: null,
            ReceivedAt: now,
          }),
        );
      } catch (err) {
        if (opts.dedupKey !== undefined && (await WorkflowEventModel.where({ InstanceId: instanceId, DedupKey: opts.dedupKey }).onPrimary().first())) return { accepted: false };
        throw err;
      }
      const wake = { Status: 'running' as const, WakeAt: null, WaitingFor: null, UpdatedAt: now };
      const r = await WorkflowInstanceModel.update(wake).where({ Id: instanceId, Status: 'waiting', WaitingFor: name });
      if (r.RowsAffected === 0 && (await this.waitPending(instanceId, name))) await WorkflowInstanceModel.update(wake).where({ Id: instanceId, Status: 'waiting', WaitingFor: '*' });
      return { accepted: true };
    });
  }

  /** WakeAt = now makes a parked instance due at once; a compensating or finished instance is left alone. */
  public async cancel(instanceId: string, reason = 'cancelled'): Promise<void> {
    const now = await this.now();
    // varchar(64) counts code points; cutting UTF-16 units could leave a lone surrogate, which has no UTF-8 encoding
    const stored = Array.from(reason).slice(0, MAX_REASON).join('');
    const r = await WorkflowInstanceModel.update({ CancelRequested: true, Reason: stored, WakeAt: now, UpdatedAt: now })
      .where('Id', instanceId)
      .whereIn('Status', CANCELLABLE);
    if (r.RowsAffected === 1) return;
    if (!(await WorkflowInstanceModel.where('Id', instanceId).onPrimary().first())) throw new WorkflowNotFound(instanceId);
  }

  public async retry(instanceId: string): Promise<void> {
    const row = await WorkflowInstanceModel.where('Id', instanceId).onPrimary().first();
    if (!row) throw new WorkflowNotFound(instanceId);
    if (row.Status !== 'failed') throw new InvalidOperation(`workflow instance '${instanceId}' is ${row.Status}; only a failed instance can be retried`);
    if (row.Reason === 'timeout') throw new InvalidOperation(`workflow instance '${instanceId}' passed its deadline; a retry would fail it again at once`);
    const now = await this.now();
    const driver = await workflowDriver();
    await driver.transaction(async () => {
      const r = await WorkflowInstanceModel.update({ Status: 'running', Reason: null, Error: null, WakeAt: null, WaitingFor: null, CancelRequested: false, FinishedAt: null, UpdatedAt: now }).where({ Id: instanceId, Status: 'failed' });
      if (r.RowsAffected !== 1) throw new InvalidOperation(`workflow instance '${instanceId}' changed while it was being retried`);
      for (const step of unobservedFailures(await WorkflowStepModel.where('InstanceId', instanceId))) {
        // a fresh attempt budget and no stale backoff; Meta.after keeps the journal causal for the replay
        const after = step.Meta?.after;
        await WorkflowStepModel.update({ Status: 'retrying', Attempt: 0, Meta: after === undefined ? null : { after } }).where('Id', step.Id);
      }
    });
  }

  public async list(filter: ListFilter): Promise<WorkflowInstanceView[]> {
    const query = WorkflowInstanceModel.query();
    if (filter.workflow !== undefined) query.where('Workflow', filter.workflow);
    if (filter.status?.length) query.whereIn('Status', filter.status);
    if (filter.after !== undefined) query.where('Id', '>', filter.after);
    const limit = Number.isFinite(filter.limit) ? Math.floor(filter.limit!) : DEFAULT_PAGE;
    const rows = await query.orderBy('Id').take(Math.min(Math.max(limit, 1), MAX_PAGE));
    return rows.map(toView);
  }

  public async health(): Promise<{ missingVersions: MissingVersion[] }> {
    return { missingVersions: await missingVersions(await this.registry()) };
  }

  /** `'*'` parks wait for several names; only a pending wait of this name may wake one (keys `wait:<name>#n`). */
  protected async waitPending(instanceId: string, name: string): Promise<boolean> {
    const row = await WorkflowStepModel.where({ InstanceId: instanceId, Kind: 'wait', Status: 'pending' }).where('Key', '>=', `wait:${name}#`).where('Key', '<', `wait:${name}$`).onPrimary().first();
    return row !== undefined;
  }

  /** Locked until the signal commits, so it is ordered against the activation's fenced status write. */
  protected async lockedStatus(driver: RawSqlDriver, id: string): Promise<WorkflowStatus | undefined> {
    const dialect = sqlDialect(driver.Options.Driver, 'locking read', 'workflow');
    const q = quoteFor(dialect);
    const lock = dialect === 'sqlite' ? '' : ' FOR UPDATE';
    const rows = await selectRows<{ Status: WorkflowStatus }>(driver, `SELECT ${q('Status')} FROM ${q('__workflow')} WHERE ${q('Id')} = ?${lock}`, [id]);
    return rows[0]?.Status;
  }

  /**
   * Inside a transaction the snapshot can predate a concurrent start that committed this id. A locking read sees
   * the latest committed row on InnoDB and on Postgres READ COMMITTED; Postgres REPEATABLE READ still cannot.
   */
  protected async existingWorkflow(driver: RawSqlDriver, id: string): Promise<string | undefined> {
    if (driver.CurrentTransaction === undefined) return (await WorkflowInstanceModel.where('Id', id).onPrimary().first())?.Workflow;
    const dialect = sqlDialect(driver.Options.Driver, 'locking read', 'workflow');
    const q = quoteFor(dialect);
    const lock = dialect === 'sqlite' ? '' : dialect === 'mysql' ? ' LOCK IN SHARE MODE' : ' FOR SHARE';
    const rows = await selectRows<{ Workflow: string }>(driver, `SELECT ${q('Workflow')} FROM ${q('__workflow')} WHERE ${q('Id')} = ?${lock}`, [id]);
    return rows[0]?.Workflow;
  }

  /** Resolved per call: an async registry injected into this sync service could arrive as a promise (doctor DI003). */
  protected registry(): Promise<WorkflowRegistry> {
    return Promise.resolve(DI.resolve(WorkflowRegistry));
  }

  /** Database time; the engine's tick re-syncs the same singleton clock. */
  protected async now(): Promise<number> {
    await (this.synced ??= this.Clock.sync().catch((e: unknown) => {
      this.synced = undefined;
      throw e;
    }));
    return this.Clock.now();
  }
}
