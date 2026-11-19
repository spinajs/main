import { buildReplayMap, type JournalRecord } from '@spinajs/durable';
import type { SerializedError, StepKind, StepMeta, StepStatus } from './contract.js';
import { NonDeterminismError } from './errors.js';
import { branchOfKey } from './lineage.js';
import { WorkflowStepModel } from './models/WorkflowStepModel.js';

export interface StepRow {
  Id: number;
  Seq: number;
  Key: string;
  Kind: StepKind;
  Status: StepStatus;
  Attempt: number;
  Result: unknown;
  ResultStored: boolean;
  Error: SerializedError | null;
  Meta: StepMeta | null;
}

/** Compensation rows sort after every step of `run`; their order is the compensation order, not a replay position. */
export const COMPENSATION_SEQ_BASE = 1_000_000;

/** `branch|kind:name`: the same name in two branches is two names. */
const nameOf = (key: string): string => `${branchOfKey(key)}|${key.slice(0, key.lastIndexOf('#'))}`;

/** `branch|call`, where a replay looks for the recorded call; a compensation has none. */
const slotOf = (r: StepRow): string | undefined => (r.Kind === 'compensate' || r.Meta?.call === undefined ? undefined : `${branchOfKey(r.Key)}|${r.Meta.call}`);

const RECORD_STATUS: Record<StepStatus, JournalRecord['status']> = { pending: 'running', succeeded: 'succeeded', retrying: 'failed', failed: 'failed' };

export function toStepRow(m: WorkflowStepModel): StepRow {
  return {
    Id: Number(m.Id),
    Seq: m.Seq,
    Key: m.Key,
    Kind: m.Kind,
    Status: m.Status,
    Attempt: m.Attempt,
    Result: m.Result ?? null,
    ResultStored: !!m.ResultStored,
    Error: m.Error ?? null,
    Meta: m.Meta ?? null,
  };
}

export class Journal {
  protected readonly byKey = new Map<string, StepRow>();
  protected readonly byCall = new Map<string, StepRow>();
  protected readonly values: Map<string, unknown>;
  protected readonly visited = new Set<string>();
  /** Recorded rows per `nameOf`. */
  protected readonly names = new Map<string, number>();
  protected lastOrder = 0;

  constructor(rows: StepRow[]) {
    for (const r of rows) {
      this.index(r);
      this.lastOrder = Math.max(this.lastOrder, r.Meta?.order ?? 0);
      if (r.Kind !== 'compensate') this.names.set(nameOf(r.Key), (this.names.get(nameOf(r.Key)) ?? 0) + 1);
    }
    // resultStored is true for every row: a step with persistResult false replays as undefined, it never runs again
    this.values = buildReplayMap(rows.map((r) => ({ key: r.Key, status: RECORD_STATUS[r.Status], result: r.ResultStored ? r.Result : undefined, resultStored: true, attempt: 1, seq: r.Seq })));
  }

  public static async load(instanceId: string): Promise<Journal> {
    const rows = await WorkflowStepModel.where('InstanceId', instanceId).onPrimary().orderBy('Seq');
    return new Journal(rows.map(toStepRow));
  }

  /**
   * D3. A replay makes every call under the number its branch gave it the first time. Rows a crash never wrote leave
   * holes, so the journal is looked up by that number, never by its position in a list. A name its branch recorded
   * once cannot hand its result to another caller, so the moment it is called may move.
   */
  public check(key: string, call: number): void {
    this.visited.add(key);
    const recorded = this.byKey.get(key);
    if (recorded && this.names.get(nameOf(key)) === 1) return;
    const there = this.byCall.get(`${branchOfKey(key)}|${call}`);
    if (there && there.Key !== key) throw new NonDeterminismError(`the journal recorded '${there.Key}' as call ${call} of its branch, this run asked for '${key}'`);
    const was = recorded?.Meta?.call;
    if (was !== undefined && was !== call) throw new NonDeterminismError(`the journal recorded '${key}' as call ${was} of its branch, this run asked for it as call ${call}`);
  }

  /** Recorded operations this run has not asked for: left over at the end of `run()`, the code changed. */
  public unvisited(): string[] {
    // a pending sleep or wait handed run() no result; a branch cut off by a park may simply not have reached it again
    const silent = (r: StepRow): boolean => r.Status === 'pending' && (r.Kind === 'sleep' || r.Kind === 'wait');
    return this.rows().flatMap((r) => (r.Kind === 'compensate' || silent(r) || this.visited.has(r.Key) ? [] : [r.Key]));
  }

  /** Succeeded steps registered with a `compensate`: the set a compensation pass must undo in full. */
  public compensable(): string[] {
    return this.rows().flatMap((r) => (r.Kind === 'step' && r.Status === 'succeeded' && r.Meta?.compensate === true ? [r.Key] : []));
  }

  public nextOrder(): number {
    return ++this.lastOrder;
  }

  public get(key: string): StepRow | undefined {
    return this.byKey.get(key);
  }

  public value(key: string): unknown {
    return this.values.get(key);
  }

  public record(row: StepRow): void {
    this.index(row);
    if (row.Status === 'succeeded') this.values.set(row.Key, row.ResultStored ? row.Result : undefined);
    else this.values.delete(row.Key);
  }

  /** Puts back the row `key` had before a write whose transaction then failed to commit. */
  public restore(key: string, previous: StepRow | undefined): void {
    const current = this.byKey.get(key);
    const slot = current && slotOf(current);
    if (slot !== undefined) this.byCall.delete(slot);
    this.byKey.delete(key);
    this.values.delete(key);
    if (previous) this.record(previous);
  }

  public rows(): StepRow[] {
    return [...this.byKey.values()].sort((a, b) => a.Seq - b.Seq);
  }

  protected index(r: StepRow): void {
    this.byKey.set(r.Key, r);
    const slot = slotOf(r);
    if (slot !== undefined) this.byCall.set(slot, r);
  }
}
