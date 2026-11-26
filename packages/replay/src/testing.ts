import type { ReplayChange, ReplayChangeOp, RowImage } from './change.js';
import type { ChangePage, ChangeReader } from './reader.js';

type Row = ReplayChange & { visible: boolean };

export type ChangeRead = 'afterInstant' | 'latest' | 'coveredSince';

export interface MemoryChange {
  readonly entity: string;
  readonly op: ReplayChangeOp;
  readonly key: string;
  readonly image?: RowImage;
  readonly before?: RowImage;
  /** Now when absent. */
  readonly at?: Date;
  readonly traceId?: string;
}

/** A change that was appended but is not visible to reads yet. */
export interface PendingChange {
  readonly entity: string;
  readonly seq: number;
}

const isRow = (v: unknown): v is RowImage => typeof v === 'object' && v !== null && !Array.isArray(v);

function json(image: RowImage | undefined): RowImage | null {
  if (image === undefined) return null;
  const copy: unknown = JSON.parse(JSON.stringify(image));
  return isRow(copy) ? copy : null;
}

/**
 * A `ChangeReader` in memory, for tests. Images go through JSON as in a trail table. Each entity numbers its changes
 * from 1, as each trail table does, so two entities share `seq` values. `appendPending` takes seqs now and shows the
 * changes only at `commit`, as a transaction that commits late; `beforeRead` runs before every read, so a test can
 * write between the reads of a replay.
 */
export class MemoryChangeReader implements ChangeReader {
  beforeRead?: (read: ChangeRead) => void | Promise<void>;
  private readonly rows: Row[] = [];
  private readonly horizon = new Map<string, Date>();
  private readonly seqs = new Map<string, number>();

  /** `pageSize`: the most changes one `afterInstant` call returns, whatever the caller asks for. */
  constructor(private readonly pageSize = 1000) {
    // A page size of 0 would answer every read with the empty page that ends a scan.
    if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError(`MemoryChangeReader: the page size must be a positive integer, not ${pageSize}`);
  }

  append(changes: readonly MemoryChange[]): this {
    this.push(changes, true);
    return this;
  }

  /** Appends changes that stay invisible until `commit`. */
  appendPending(changes: readonly MemoryChange[]): PendingChange[] {
    return this.push(changes, false);
  }

  commit(pending: readonly PendingChange[]): void {
    for (const r of this.rows) if (pending.some((p) => p.entity === r.entity && p.seq === r.seq)) r.visible = true;
  }

  /** Every write of `entity` from `since` on is in this stream. */
  cover(entity: string, since: Date): this {
    this.horizon.set(entity, since);
    return this;
  }

  /** Retention: drops the changes at or before `cutoff` and moves every horizon up to it, in one step. */
  prune(cutoff: Date): void {
    this.rows.splice(0, this.rows.length, ...this.rows.filter((r) => r.at > cutoff));
    for (const [entity, since] of this.horizon) if (since < cutoff) this.horizon.set(entity, cutoff);
  }

  async afterInstant(entity: string, at: Date, page: ChangePage): Promise<readonly ReplayChange[]> {
    await this.beforeRead?.('afterInstant');
    return this.rows
      .filter((r) => r.visible && r.entity === entity && r.at > at && (page.after === undefined || r.seq > page.after))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, Math.min(page.limit, this.pageSize))
      .map(strip);
  }

  async latest(entity: string, keys: readonly string[], at?: Date): Promise<ReadonlyMap<string, ReplayChange>> {
    await this.beforeRead?.('latest');
    const out = new Map<string, ReplayChange>();
    const candidates = this.rows.filter((r) => r.visible && r.entity === entity && keys.includes(r.key) && (at === undefined || r.at <= at));
    for (const r of candidates) if ((out.get(r.key)?.seq ?? -1) < r.seq) out.set(r.key, strip(r));
    return out;
  }

  async coveredSince(entity: string): Promise<Date | undefined> {
    await this.beforeRead?.('coveredSince');
    return this.horizon.get(entity);
  }

  private push(changes: readonly MemoryChange[], visible: boolean): PendingChange[] {
    return changes.map((c) => {
      const seq = (this.seqs.get(c.entity) ?? 0) + 1;
      this.seqs.set(c.entity, seq);
      this.rows.push({ entity: c.entity, key: c.key, op: c.op, image: json(c.image), before: json(c.before), at: c.at ?? new Date(), seq, traceId: c.traceId ?? null, visible });
      return { entity: c.entity, seq };
    });
  }
}

function strip(r: Row): ReplayChange {
  const { visible: _visible, ...change } = r;
  return { ...change, image: json(change.image ?? undefined), before: json(change.before ?? undefined) };
}
