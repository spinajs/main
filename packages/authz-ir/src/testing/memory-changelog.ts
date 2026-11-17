import { AuthzConfigError, ChangeLog } from '@spinajs/authz';
import type { ChangeEntry, ChangeKind, ChangeQuery, ChangeRecord, ResourceType } from '@spinajs/authz';

type Row = ChangeRecord & { visible: boolean };
export type ChangeLogRead = 'since' | 'until' | 'afterInstant' | 'latest' | 'coveredSince';

const json = (v: unknown): unknown => (v === undefined ? null : (JSON.parse(JSON.stringify(v)) as unknown));
const horizonKey = (kind: ChangeKind, type?: ResourceType): string => (kind === 'column' ? `column:${type ?? ''}` : kind);

/**
 * A `ChangeLog` in memory, for tests. Payloads go through JSON as in the database. `appendPending` takes seqs now and
 * shows the rows only at `commit`, as a transaction that commits late; `beforeRead` runs before every query, so a test
 * can write between the reads of a replay.
 */
export class MemoryChangeLog extends ChangeLog {
  beforeRead?: (method: ChangeLogRead) => void | Promise<void>;
  private readonly rows: Row[] = [];
  private readonly horizon = new Map<string, Date>();
  private readonly tracked = new Set<ChangeKind>();
  private seq = 0;

  covers(kind: ChangeKind): boolean {
    return this.tracked.has(kind);
  }

  track(kind: ChangeKind): void {
    this.tracked.add(kind);
  }

  append(entries: readonly ChangeEntry[]): Promise<void> {
    this.push(entries, true);
    return Promise.resolve();
  }

  /** Appends rows that stay invisible until `commit(seqs)`. */
  appendPending(entries: readonly ChangeEntry[]): number[] {
    return this.push(entries, false);
  }

  commit(seqs: readonly number[]): void {
    for (const r of this.rows) if (seqs.includes(r.seq)) r.visible = true;
  }

  /** Every write of `kind` (of `type`, for `column`) from `since` on is in this log. */
  cover(kind: ChangeKind, since: Date, type?: ResourceType): this {
    this.horizon.set(horizonKey(kind, type), since);
    return this;
  }

  /** Retention: drops the changes at or before `cutoff` and moves every horizon up to it, in one step. */
  prune(cutoff: Date): void {
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i].at <= cutoff) this.rows.splice(i, 1);
    for (const [k, since] of this.horizon) if (since < cutoff) this.horizon.set(k, cutoff);
  }

  async since(seq: number, query?: ChangeQuery): Promise<readonly ChangeRecord[]> {
    await this.beforeRead?.('since');
    return this.page((r) => r.seq > seq, query);
  }

  async until(at: Date, query?: ChangeQuery): Promise<readonly ChangeRecord[]> {
    await this.beforeRead?.('until');
    return this.page((r) => r.at <= at, query);
  }

  async afterInstant(at: Date, query?: ChangeQuery): Promise<readonly ChangeRecord[]> {
    await this.beforeRead?.('afterInstant');
    return this.page((r) => r.at > at, query);
  }

  async latest(kind: ChangeKind, keys: readonly string[], at?: Date): Promise<ReadonlyMap<string, ChangeRecord>> {
    await this.beforeRead?.('latest');
    const out = new Map<string, ChangeRecord>();
    for (const r of this.rows) if (r.visible && r.kind === kind && keys.includes(r.key) && (at === undefined || r.at <= at) && (out.get(r.key)?.seq ?? -1) < r.seq) out.set(r.key, strip(r));
    return out;
  }

  async coveredSince(kind: ChangeKind, resourceType?: ResourceType): Promise<Date | undefined> {
    await this.beforeRead?.('coveredSince');
    if (kind === 'column' && resourceType === undefined) return undefined;
    return this.horizon.get(horizonKey(kind, resourceType));
  }

  lost(kind: ChangeKind, resourceType?: ResourceType): Promise<void> {
    const now = new Date();
    for (const k of this.horizon.keys()) if (k === horizonKey(kind, resourceType) || (kind === 'column' && resourceType === undefined && k.startsWith('column:'))) this.horizon.set(k, now);
    return Promise.resolve();
  }

  private push(entries: readonly ChangeEntry[], visible: boolean): number[] {
    return entries.map((e) => {
      this.rows.push({ seq: ++this.seq, at: e.at ?? new Date(), kind: e.kind, op: e.op, key: e.key, payload: json(e.payload), before: json(e.before), actor: e.actor ?? null, traceId: null, visible });
      return this.seq;
    });
  }

  private page(filter: (r: Row) => boolean, query: ChangeQuery = {}): ChangeRecord[] {
    const limit = query.limit ?? 1000;
    if (!Number.isInteger(limit) || limit < 0 || limit > 10_000) throw new AuthzConfigError('ChangeLog: limit must be an integer from 0 to 10000');
    return this.rows
      .filter((r) => r.visible && filter(r) && (query.after === undefined || r.seq > query.after) && (query.kinds === undefined || query.kinds.includes(r.kind)))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map(strip);
  }
}

function strip(r: Row): ChangeRecord {
  const { visible: _visible, ...record } = r;
  return record;
}
