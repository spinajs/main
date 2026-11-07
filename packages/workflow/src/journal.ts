import { buildReplayMap, type JournalRecord } from '@spinajs/durable';
import type { SerializedError, StepKind, StepMeta, StepStatus } from './contract.js';
import { NonDeterminismError } from './errors.js';
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

const baseOf = (key: string): string => key.slice(0, key.lastIndexOf('#'));

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
  protected readonly bySeq = new Map<number, StepRow>();
  protected readonly values: Map<string, unknown>;
  protected readonly visited = new Set<string>();
  protected readonly occurrences = new Map<string, number>();
  protected lastOrder = 0;
  /** Every row carries `Meta.after`: replays are gated and checked by position. Older or mixed journals get the lenient check only. */
  public readonly causal: boolean;

  constructor(rows: StepRow[]) {
    this.causal = rows.every((r) => r.Kind === 'compensate' || typeof r.Meta?.after === 'number');
    for (const r of rows) {
      this.index(r);
      this.lastOrder = Math.max(this.lastOrder, r.Meta?.order ?? 0);
      if (r.Kind !== 'compensate') this.occurrences.set(baseOf(r.Key), (this.occurrences.get(baseOf(r.Key)) ?? 0) + 1);
    }
    // resultStored is true for every row: a step with persistResult false replays as undefined, it never runs again
    this.values = buildReplayMap(rows.map((r) => ({ key: r.Key, status: RECORD_STATUS[r.Status], result: r.ResultStored ? r.Result : undefined, resultStored: true, attempt: 1, seq: r.Seq })));
  }

  public static async load(instanceId: string): Promise<Journal> {
    const rows = await WorkflowStepModel.where('InstanceId', instanceId).onPrimary().orderBy('Seq');
    return new Journal(rows.map(toStepRow));
  }

  /** D3. `after`: the results delivered to run() before this call. */
  public check(seq: number, key: string, after: number): void {
    this.visited.add(key);
    if (this.causal) this.checkCausal(seq, key, after);
    else this.checkLenient(seq, key);
  }

  /**
   * A gated replay makes every call at its recorded position, after as many results as it was the first time. A
   * recorded name used once cannot hand its result to the wrong caller, so timing between steps may move it.
   */
  protected checkCausal(seq: number, key: string, after: number): void {
    const recorded = this.byKey.get(key);
    if (recorded && this.occurrences.get(baseOf(key)) === 1) return;
    const atSeq = this.bySeq.get(seq);
    if (atSeq && atSeq.Key !== key) throw new NonDeterminismError(`the journal recorded '${atSeq.Key}' at position ${seq}, this run asked for '${key}'`);
    if (recorded && recorded.Seq !== seq) throw new NonDeterminismError(`the journal recorded '${key}' at position ${recorded.Seq}, this run asked for it at ${seq}`);
    const was = recorded?.Meta?.after;
    if (was !== undefined && was !== after) throw new NonDeterminismError(`the journal recorded '${key}' after ${was} results, this run asked for it after ${after}`);
  }

  /** Without causality the replay order is call order, so positions are compared only between occurrences of one `kind:name`. */
  protected checkLenient(seq: number, key: string): void {
    const base = baseOf(key);
    const atSeq = this.bySeq.get(seq);
    if (atSeq && atSeq.Key !== key && baseOf(atSeq.Key) === base) {
      throw new NonDeterminismError(`the journal recorded '${atSeq.Key}' at position ${seq}, this run asked for '${key}'`);
    }
    const recorded = this.byKey.get(key);
    if (recorded && recorded.Seq !== seq && (this.occurrences.get(base) ?? 0) > 1) {
      throw new NonDeterminismError(`the journal recorded '${key}' at position ${recorded.Seq}, this run asked for it at ${seq}`);
    }
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
    if (current && current.Kind !== 'compensate') this.bySeq.delete(current.Seq);
    this.byKey.delete(key);
    this.values.delete(key);
    if (previous) this.record(previous);
  }

  public rows(): StepRow[] {
    return [...this.byKey.values()].sort((a, b) => a.Seq - b.Seq);
  }

  protected index(r: StepRow): void {
    this.byKey.set(r.Key, r);
    if (r.Kind !== 'compensate') this.bySeq.set(r.Seq, r);
  }
}
