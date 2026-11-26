import type { ReplayChange } from './change.js';
import type { ReplayBudget } from './contracts.js';
import type { ReplayWindow } from './history.js';
import type { ChangeReader } from './reader.js';

/** A replay read more history than its limits allow. */
export class ReplayBudgetExceeded extends Error {
  override readonly name = 'ReplayBudgetExceeded';

  constructor(
    readonly limit: 'maxChanges' | 'maxKeys',
    readonly count: number,
  ) {
    super(`${limit} exceeded: ${count}`);
  }
}

/** Each member out of its range makes `load` throw a `RangeError` that names it. */
export interface ReplayHistoryLimits extends ReplayBudget {
  /** Distinct `(entity, seq)` changes over all passes: an integer of 0 or more. */
  maxChanges: number;
  /** Distinct `(entity, key)` pairs `reserve` and `headOf` resolve: an integer of 0 or more. */
  maxKeys: number;
  /** `beforeMs` and `afterMs`: each a finite number of 0 or more. */
  window: ReplayWindow;
  /** One precision for every key of the history: that of the coarsest column any image takes instants from; a finite number above 0, default 1 ms. */
  precisionMs?: number;
  /** The reader's clock, which catch-up passes overlap from; default `Date.now`. Each pass refuses a value that is not finite. */
  now?: () => number;
}

const PAGE = 10_000;
const KEY_BATCH = 500;

/**
 * A history stream from the backward edge of a recording's window on: one paged scan per entity at load, then per-key
 * lookups. The scan starts at `T - window.beforeMs`, so a key removed inside the window, absent now, is still a
 * candidate whose change the window check sees. Callers read in this order: scan, current rows, `catchUp`, `headOf`,
 * `beforeOf`, and `since` last.
 */
export class ReplayHistory {
  private readonly byKey = new Map<string, ReplayChange[]>();
  // Per key, the seq of its first change the last pass read new on a page after the first (see catchUp).
  private readonly unconfirmed = new Map<string, number>();
  private readonly resolved = new Set<string>();
  private readonly seen = new Set<string>();
  private lastPass: number | undefined;
  private passing = false;
  private failed: { cause: unknown } | undefined;

  private constructor(
    private readonly reader: ChangeReader,
    readonly at: Date,
    readonly entities: readonly string[],
    readonly limits: ReplayHistoryLimits,
    private readonly signal?: AbortSignal,
  ) {}

  /** @throws RangeError for an invalid `at` or limit; ReplayBudgetExceeded past `maxChanges`; Error for a reader whose page breaks the order of `ChangeReader` */
  static async load(reader: ChangeReader, at: Date, entities: readonly string[], limits: ReplayHistoryLimits, signal?: AbortSignal): Promise<ReplayHistory> {
    checkLimits(at, limits);
    const history = new ReplayHistory(reader, at, entities, limits, signal);
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

  /**
   * The key's scanned changes in `seq` order, up to the first one the last pass read new on a page after the first: that
   * page may have passed over an earlier change of the key. What is held back is at the end, where `headOf` shows it.
   * Changes at or before T lie inside the window, which makes the key a gap. @throws Error for an entity that was not scanned
   */
  afterFor(entity: string, key: string): readonly ReplayChange[] {
    this.usable();
    this.scanned(entity);
    const s = slot(entity, key);
    const changes = this.byKey.get(s) ?? [];
    const cut = this.unconfirmed.get(s);
    return cut === undefined ? changes : changes.filter((c) => c.seq < cut);
  }

  /** @throws Error for an entity that was not scanned, when the first change is asked for */
  *changesOf(entity: string): Iterable<ReplayChange> {
    this.usable();
    this.scanned(entity);
    for (const changes of this.byKey.values()) if (changes[0].entity === entity) yield* changes;
  }

  /**
   * Scans the changes committed since the previous pass, so a write that landed during the replay is seen. Each pass
   * starts the window's backward side before the previous one began, not at a `seq` cursor: sequence numbers commit
   * out of order, and a change inserted before a pass and committed after it carries an `at` at most commit lag and
   * clock skew earlier than that pass. A transaction open longer than that is not seen.
   *
   * A pass is not atomic: each page is its own statement. A page can pass over a change whose transaction is still
   * open while a later page shows the next change of the same key, which waited for that commit. Only a change read
   * new on a page after the first can have such a gap below it, so `afterFor` holds it back; the next pass reads the
   * earlier change, committed for the whole of that pass, and the note is cleared.
   *
   * While a pass runs, and after one failed (the reader, the signal or a budget stopped it), every read of the history
   * throws: the pass cleared the notes before it read. A later pass that completes makes the history answer again; it
   * starts where the last completed pass started, so it reads what the failed one skipped. One pass at a time.
   */
  async catchUp(): Promise<void> {
    if (this.passing) throw running();
    const started = (this.limits.now ?? Date.now)();
    if (!Number.isFinite(started)) throw new RangeError(`ReplayHistory: now must be a clock of finite numbers, not one that returns ${started}`);
    // afterInstant is strict and the window inclusive: a change exactly on the edge must still be scanned.
    const edge = this.at.getTime() - this.limits.window.beforeMs - 1;
    const from = new Date(this.lastPass === undefined ? edge : Math.max(edge, this.lastPass - this.limits.window.beforeMs));
    this.passing = true;
    try {
      this.unconfirmed.clear();
      for (const entity of this.entities) await this.scan(entity, from);
      this.lastPass = started;
      this.failed = undefined;
    } catch (e) {
      this.failed = { cause: e };
      throw e;
    } finally {
      this.passing = false;
    }
  }

  private usable(): void {
    if (this.passing) throw running();
    if (this.failed !== undefined) {
      throw new Error('ReplayHistory: the last catchUp failed, so a key could show a change without the one before it; the history answers again after a catchUp that completes', { cause: this.failed.cause });
    }
  }

  // No change of an entity that was never scanned is held here: an empty answer would read as "nothing changed after T".
  private scanned(entity: string): void {
    if (!this.entities.includes(entity)) throw new Error(`ReplayHistory: the ${entity} changes were not scanned; the history was loaded for ${this.entities.join(', ')}`);
  }

  /** Each key's last change at or before T. */
  beforeOf(entity: string, keys: readonly string[]): Promise<ReadonlyMap<string, ReplayChange>> {
    this.usable();
    return this.latest(entity, keys, this.at);
  }

  /**
   * Each key's last change, whenever it happened: read after the current rows, it shows a write the scan missed. The
   * first lookup of a key, so the keys count against `maxKeys` here. @throws ReplayBudgetExceeded past `maxKeys`
   */
  headOf(entity: string, keys: readonly string[]): Promise<ReadonlyMap<string, ReplayChange>> {
    this.reserve(entity, keys);
    return this.latest(entity, keys);
  }

  /** Counts keys against `maxKeys` before anything is read for them. @throws ReplayBudgetExceeded past `maxKeys` */
  reserve(entity: string, keys: readonly string[]): void {
    this.usable();
    for (const k of keys) this.resolved.add(slot(entity, k));
    if (this.resolved.size > this.limits.maxKeys) throw new ReplayBudgetExceeded('maxKeys', this.resolved.size);
  }

  /** Not memoised: coverage only moves forward, and it must be read after the history it vouches for (a prune deletes rows and moves it in one commit). */
  since(entity: string): Promise<Date | undefined> {
    this.usable();
    this.signal?.throwIfAborted();
    return this.reader.coveredSince(entity);
  }

  // Ends: checkPage makes the cursor rise on every page, so at most `changes` pages bring nothing new, and every other
  // page counts toward `maxChanges`.
  private async scan(entity: string, from: Date): Promise<void> {
    let cursor: number | undefined;
    for (;;) {
      this.signal?.throwIfAborted();
      const page = await this.reader.afterInstant(entity, from, { limit: PAGE, ...(cursor === undefined ? {} : { after: cursor }) });
      // A reader may cap a page below `limit`, so only an empty page ends the scan.
      if (page.length === 0) return;
      checkPage(this.reader, entity, page, cursor);
      for (const c of page) if (this.add(c) && cursor !== undefined) this.holdBack(c);
      cursor = page[page.length - 1].seq;
    }
  }

  /** False for a change already scanned. */
  private add(c: ReplayChange): boolean {
    const id = slot(c.entity, String(c.seq));
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    const s = slot(c.entity, c.key);
    const list = this.byKey.get(s) ?? [];
    list.push(c);
    if (list.length > 1 && list[list.length - 2].seq > c.seq) list.sort((a, b) => a.seq - b.seq);
    this.byKey.set(s, list);
    // Only after the change is kept: a pass that completes after the stop takes it as scanned.
    if (this.seen.size > this.limits.maxChanges) throw new ReplayBudgetExceeded('maxChanges', this.seen.size);
    return true;
  }

  // Pages come in ascending seq, so the first change held back for a key in a pass is its lowest.
  private holdBack(c: ReplayChange): void {
    const s = slot(c.entity, c.key);
    if (!this.unconfirmed.has(s)) this.unconfirmed.set(s, c.seq);
  }

  private async latest(entity: string, keys: readonly string[], at?: Date): Promise<ReadonlyMap<string, ReplayChange>> {
    const out = new Map<string, ReplayChange>();
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += KEY_BATCH) {
      this.signal?.throwIfAborted();
      const found = await this.reader.latest(entity, unique.slice(i, i + KEY_BATCH), at);
      for (const [k, c] of found) out.set(k, c);
    }
    return out;
  }
}

const slot = (entity: string, key: string): string => `${entity}\u0000${key}`;

const running = (): Error => new Error('ReplayHistory: a catchUp is running; await it before the next pass or read');

const isCount = (v: number): boolean => Number.isSafeInteger(v) && v >= 0;
const isSpan = (v: number): boolean => Number.isFinite(v) && v >= 0;

// NaN never compares above a budget, and a negative `beforeMs` moves the scan's edge after T: both fail open.
function checkLimits(at: Date, limits: ReplayHistoryLimits): void {
  const checks: [string, number, (v: number) => boolean, string][] = [
    ['at', at.getTime(), Number.isFinite, 'a valid date'],
    ['maxChanges', limits.maxChanges, isCount, 'an integer of 0 or more'],
    ['maxKeys', limits.maxKeys, isCount, 'an integer of 0 or more'],
    ['window.beforeMs', limits.window.beforeMs, isSpan, 'a finite number of 0 or more'],
    ['window.afterMs', limits.window.afterMs, isSpan, 'a finite number of 0 or more'],
    ['precisionMs', limits.precisionMs ?? 1, (v) => Number.isFinite(v) && v > 0, 'a finite number above 0'],
  ];
  for (const [member, value, valid, range] of checks) if (!valid(value)) throw new RangeError(`ReplayHistory: ${member} must be ${range}, not ${value}`);
}

// The hold-back and the end of a scan rest on this order; a reader that ignores `page.after` would loop the scan forever.
function checkPage(reader: ChangeReader, entity: string, page: readonly ReplayChange[], after: number | undefined): void {
  const name = reader.constructor.name;
  const broken = (what: string): Error =>
    new Error(`ReplayHistory: ${name === '' || name === 'Object' ? 'the change reader' : name} answered a page of ${entity} after seq ${after ?? 'none'} that ${what}; a page holds at most ${PAGE} changes of its entity, in ascending seq above the cursor`);
  if (page.length > PAGE) throw broken(`holds ${page.length} changes`);
  let previous = after;
  for (const c of page) {
    if (c.entity !== entity) throw broken(`holds a change of ${c.entity}`);
    if (!(c.seq > (previous ?? -Infinity))) throw broken(`holds seq ${c.seq}, not above ${previous === after ? 'the cursor' : `seq ${previous} before it`}`);
    previous = c.seq;
  }
}
