import { Autoinject, DI, Injectable, Singleton, type Constructor } from '@spinajs/di';
import { DbClock, quoteFor, sqlDialect, type RawSqlDriver } from '@spinajs/durable';
import { InvalidArgument, NotSupported } from '@spinajs/exceptions';
import { UniqueViolation } from '@spinajs/orm';
import { v4 as uuidv4 } from 'uuid';
import type { StartOptions, WorkflowInstanceView, WorkflowStatus } from './contract.js';
import { WorkflowIdConflict, WorkflowStartConflict } from './errors.js';
import { identifierProblem } from './identifier.js';
import { safeStringify } from './json.js';
import { WorkflowInstanceModel } from './models/WorkflowInstanceModel.js';
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

function inputColumn(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const text = safeStringify(input);
  if (text === undefined) throw new InvalidArgument('workflow input must be representable as JSON');
  return text;
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
    const inputText = inputColumn(input);
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

  public signal(): Promise<{ accepted: boolean }> {
    return Promise.reject(new NotSupported('WorkflowService.signal()'));
  }

  public cancel(): Promise<void> {
    return Promise.reject(new NotSupported('WorkflowService.cancel()'));
  }

  public retry(): Promise<void> {
    return Promise.reject(new NotSupported('WorkflowService.retry()'));
  }

  public list(): Promise<WorkflowInstanceView[]> {
    return Promise.reject(new NotSupported('WorkflowService.list()'));
  }

  public health(): Promise<{ missingVersions: MissingVersion[] }> {
    return Promise.reject(new NotSupported('WorkflowService.health()'));
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
