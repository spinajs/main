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
 * The changelog from the backward edge of a decision's window on: one paged scan at load, then per-key lookups. The
 * scan starts at `T - window.beforeMs`, so a key removed inside the window, absent now, is still a candidate whose
 * change the window check sees. Callers read in the order of section 3.2: scan, current rows, `catchUp`, `headOf`,
 * `beforeOf`, and `since` last.
 */
export class ReplayHistory {
  private readonly byKey = new Map<string, ChangeRecord[]>();
  private readonly resolved = new Set<string>();
  private readonly seen = new Set<number>();
  private lastPass: number | undefined;

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
    return this.seen.size;
  }

  /** Distinct keys resolved so far. */
  get keys(): number {
    return this.resolved.size;
  }

  /** The key's scanned changes; those at or before T lie inside the window, which makes the key a gap. */
  afterFor(kind: ChangeKind, key: string): readonly ChangeRecord[] {
    return this.byKey.get(slot(kind, key)) ?? [];
  }

  *edges(kind: ChangeKind, decode: HistoryContributor['edges']): Iterable<HistoryEdge> {
    for (const changes of this.byKey.values()) {
      if (changes[0].kind !== kind) continue;
      for (const c of changes) yield* decode(c);
    }
  }

  /**
   * Scans the changes committed since the previous pass, so a write that landed during the replay is seen. Each pass
   * starts the window's backward side before the previous one began, not at a `seq` cursor: sequence numbers commit
   * out of order, and a change inserted before a pass and committed after it carries an `at` at most commit lag and
   * clock skew earlier than that pass (R7).
   */
  async catchUp(): Promise<void> {
    const started = Date.now();
    const edge = this.at.getTime() - this.limits.window.beforeMs;
    const from = new Date(this.lastPass === undefined ? edge : Math.max(edge, this.lastPass - this.limits.window.beforeMs));
    let cursor: number | undefined;
    for (;;) {
      this.signal?.throwIfAborted();
      const page = await this.log.afterInstant(from, { kinds: this.kinds, limit: PAGE, ...(cursor === undefined ? {} : { after: cursor }) });
      for (const c of page) this.add(c);
      if (page.length < PAGE) break;
      cursor = page[page.length - 1].seq;
    }
    this.lastPass = started;
  }

  /** Each key's last change at or before T. */
  beforeOf(kind: ChangeKind, keys: readonly string[]): Promise<ReadonlyMap<string, ChangeRecord>> {
    return this.latest(kind, keys, this.at);
  }

  /**
   * Each key's last change, whenever it happened: read after the current rows, it shows a write the scan missed. The
   * first lookup of a key, so the keys count against `maxKeys` here. @throws ReplayBudgetExceeded past `maxKeys`
   */
  headOf(kind: ChangeKind, keys: readonly string[]): Promise<ReadonlyMap<string, ChangeRecord>> {
    for (const k of keys) this.resolved.add(slot(kind, k));
    if (this.resolved.size > this.limits.maxKeys) throw new ReplayBudgetExceeded('maxKeys', this.resolved.size);
    return this.latest(kind, keys);
  }

  /** Not memoised: coverage only moves forward, and it must be read after the history it vouches for (a prune deletes rows and moves it in one commit). */
  since(kind: ChangeKind, type?: ResourceType): Promise<Date | undefined> {
    this.signal?.throwIfAborted();
    return this.log.coveredSince(kind, type);
  }

  private add(c: ChangeRecord): void {
    if (this.seen.has(c.seq)) return;
    this.seen.add(c.seq);
    if (this.seen.size > this.limits.maxChanges) throw new ReplayBudgetExceeded('maxChanges', this.seen.size);
    const s = slot(c.kind, c.key);
    const list = this.byKey.get(s) ?? [];
    list.push(c);
    if (list.length > 1 && list[list.length - 2].seq > c.seq) list.sort((a, b) => a.seq - b.seq);
    this.byKey.set(s, list);
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
