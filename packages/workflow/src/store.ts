import type { RowLease, RowLeaseTarget } from '@spinajs/durable';
import type { SerializedError, StepKind, StepMeta, StepStatus } from './contract.js';
import { LeaseLostError } from './errors.js';
import type { StepRow } from './journal.js';
import { jsonColumn } from './models/converters.js';
import { WorkflowInstanceModel } from './models/WorkflowInstanceModel.js';
import { WorkflowStepModel } from './models/WorkflowStepModel.js';
import type { RawSqlDriver } from './sql.js';

export interface StepWrite {
  instanceId: string;
  seq: number;
  key: string;
  kind: StepKind;
  status: StepStatus;
  attempt: number;
  /** Absent or `{ value: undefined }`: nothing stored, a replay resolves `undefined`. */
  result?: { value: unknown };
  error?: SerializedError | null;
  /** Absent on an update: the row keeps its meta. */
  meta?: StepMeta | null;
  startedAt: number;
  finishedAt: number | null;
}

/**
 * Every write of an activation names its claim epoch. A replica whose claim was taken over matches no
 * row, so its late writes are discarded instead of overwriting the new owner's progress (semantic 5).
 */
export class InstanceStore {
  constructor(public readonly driver: RawSqlDriver, public readonly lease: RowLease, public readonly owner: string) {}

  public target(instanceId: string): RowLeaseTarget {
    return { table: '__workflow', key: { Id: instanceId } };
  }

  public fence(instanceId: string, epoch: number): Record<string, unknown> {
    return { ...this.lease.fenced(this.target(instanceId), this.owner, epoch), Id: instanceId };
  }

  /**
   * `work` commits only while this owner holds `epoch`: the fence UPDATE and `work` share a transaction
   * (a savepoint inside an open one), and the UPDATE's row lock keeps a new claim out until the commit.
   */
  public fenced<T>(instanceId: string, epoch: number, now: number, work: () => Promise<T>): Promise<T> {
    return this.driver.transaction(async () => {
      const r = await WorkflowInstanceModel.update({ UpdatedAt: now }).where(this.fence(instanceId, epoch));
      if (r.RowsAffected !== 1) throw new LeaseLostError(instanceId);
      return work();
    });
  }

  public async update(instanceId: string, epoch: number, patch: Partial<WorkflowInstanceModel>): Promise<void> {
    const r = await WorkflowInstanceModel.update(patch).where(this.fence(instanceId, epoch));
    if (r.RowsAffected !== 1) throw new LeaseLostError(instanceId);
  }

  public release(instanceId: string, epoch: number): Promise<boolean> {
    return this.lease.release(this.target(instanceId), this.owner, epoch);
  }

  /** Inserts the row the first time a key is journaled and updates it afterwards (a retry, a marker that resolved). */
  public async saveStep(existing: StepRow | undefined, w: StepWrite): Promise<StepRow> {
    const stored = w.result !== undefined && w.result.value !== undefined;
    const result = stored ? w.result!.value : null;
    const error = w.error ?? null;
    if (existing) {
      const meta = w.meta === undefined ? existing.Meta : w.meta;
      await WorkflowStepModel.update({ Status: w.status, Attempt: w.attempt, Result: result, ResultStored: stored, Error: error, Meta: meta, FinishedAt: w.finishedAt }).where('Id', existing.Id);
      return { ...existing, Status: w.status, Attempt: w.attempt, Result: result, ResultStored: stored, Error: error, Meta: meta };
    }
    const meta = w.meta ?? null;
    const created = await WorkflowStepModel.create({
      InstanceId: w.instanceId,
      Seq: w.seq,
      Key: w.key,
      Kind: w.kind,
      Status: w.status,
      Attempt: w.attempt,
      Result: jsonColumn(result),
      ResultStored: stored,
      Error: jsonColumn(error),
      Meta: jsonColumn(meta),
      StartedAt: w.startedAt,
      FinishedAt: w.finishedAt,
    } as Partial<WorkflowStepModel>);
    return { Id: Number(created.Id), Seq: w.seq, Key: w.key, Kind: w.kind, Status: w.status, Attempt: w.attempt, Result: result, ResultStored: stored, Error: error, Meta: meta };
  }
}
