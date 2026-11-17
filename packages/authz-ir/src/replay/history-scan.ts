import type { ChangeKind, ChangeLog, ChangeRecord, ResourceType } from '@spinajs/authz';

import type { HistoryContributor, HistoryEdge } from './contributor.js';
import type { ReplayWindow } from './history.js';

/** A replay read more history than its limits allow. */
export class ReplayBudgetExceeded extends Error {
  constructor(
    readonly limit: 'maxChanges' | 'maxKeys',
    readonly count: number,
  ) {
    super(`${limit} exceeded: ${count}`);
  }
}

export interface ReplayHistoryLimits {
  maxChanges: number;
  maxKeys: number;
  window: ReplayWindow;
  /** Stored precision of instants inside payloads (`changeLogPrecisionMs`); default 1. */
  precisionMs?: number;
}

const PAGE = 10_000;
const KEY_BATCH = 500;

/**
 * The changelog after a decision's instant T: one paged scan at load, then per-key lookups. Callers read in the order
 * of section 3.2: scan, current rows, `catchUp`, `headOf`, `beforeOf`, and `since` last.
 */
export class ReplayHistory {
  private readonly byKey = new Map<string, ChangeRecord[]>();
  private readonly resolved = new Set<string>();
  private cursor: number | undefined;
  private count = 0;

  private constructor(
    private readonly log: ChangeLog,
    readonly at: Date,
    readonly kinds: readonly ChangeKind[],
    readonly limits: ReplayHistoryLimits,
    private readonly signal?: AbortSignal,
  ) {}

  /** @throws ReplayBudgetExceeded past `maxChanges` */
  static async load(log: ChangeLog, at: Date, kinds: readonly ChangeKind[], limits: ReplayHistoryLimits, signal?: AbortSignal): Promise<ReplayHistory> {
    const history = new ReplayHistory(log, at, kinds, limits, signal);
    await history.catchUp();
    return history;
  }

  get window(): ReplayWindow {
    return this.limits.window;
  }

  get precisionMs(): number {
    return this.limits.precisionMs ?? 1;
  }

  /** Changes scanned so far. */
  get changes(): number {
    return this.count;
  }

  /** Distinct keys resolved so far. */
  get keys(): number {
    return this.resolved.size;
  }

  afterFor(kind: ChangeKind, key: string): readonly ChangeRecord[] {
    return this.byKey.get(slot(kind, key)) ?? [];
  }

  *edges(kind: ChangeKind, decode: HistoryContributor['edge']): Iterable<HistoryEdge> {
    for (const changes of this.byKey.values()) {
      if (changes[0].kind !== kind) continue;
      for (const c of changes) {
        const e = decode(c);
        if (e !== undefined) yield e;
      }
    }
  }

  /** Scans the changes after T committed since the last page, so a write that landed during the replay is seen. */
  async catchUp(): Promise<void> {
    for (;;) {
      this.signal?.throwIfAborted();
      const page = await this.log.afterInstant(this.at, { kinds: this.kinds, limit: PAGE, ...(this.cursor === undefined ? {} : { after: this.cursor }) });
      for (const c of page) this.add(c);
      if (page.length < PAGE) return;
    }
  }

  /** Each key's last change at or before T. @throws ReplayBudgetExceeded past `maxKeys` */
  beforeOf(kind: ChangeKind, keys: readonly string[]): Promise<ReadonlyMap<string, ChangeRecord>> {
    for (const k of keys) this.resolved.add(slot(kind, k));
    if (this.resolved.size > this.limits.maxKeys) throw new ReplayBudgetExceeded('maxKeys', this.resolved.size);
    return this.latest(kind, keys, this.at);
  }

  /** Each key's last change, whenever it happened: read after the current rows, it shows a write the scan missed. */
  headOf(kind: ChangeKind, keys: readonly string[]): Promise<ReadonlyMap<string, ChangeRecord>> {
    return this.latest(kind, keys);
  }

  /** Not memoised: coverage only moves forward, and it must be read after the history it vouches for (a prune deletes rows and moves it in one commit). */
  since(kind: ChangeKind, type?: ResourceType): Promise<Date | undefined> {
    this.signal?.throwIfAborted();
    return this.log.coveredSince(kind, type);
  }

  private add(c: ChangeRecord): void {
    if (++this.count > this.limits.maxChanges) throw new ReplayBudgetExceeded('maxChanges', this.count);
    this.cursor = Math.max(this.cursor ?? c.seq, c.seq);
    const s = slot(c.kind, c.key);
    const list = this.byKey.get(s);
    if (list) list.push(c);
    else this.byKey.set(s, [c]);
  }

  private async latest(kind: ChangeKind, keys: readonly string[], at?: Date): Promise<ReadonlyMap<string, ChangeRecord>> {
    const out = new Map<string, ChangeRecord>();
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += KEY_BATCH) {
      this.signal?.throwIfAborted();
      const found = await this.log.latest(kind, unique.slice(i, i + KEY_BATCH), at);
      for (const [k, c] of found) out.set(k, c);
    }
    return out;
  }
}

const slot = (kind: ChangeKind, key: string): string => `${kind}\u0000${key}`;
