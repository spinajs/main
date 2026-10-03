import type { Assignment, AssignmentSubject, EvaluationContext } from '@spinajs/authz';

import type { AssignmentStore } from '../contracts.js';
import { subjectKey } from './assignments.js';

type Rows = readonly Assignment[];

export const DEFAULT_ASSIGNMENTS_TTL_SECONDS = 60;
export const DEFAULT_MAX_CACHED_SUBJECTS = 10_000;

export interface AssignmentCacheOptions {
  /** How long a subject's rows serve later requests; 0 keeps nothing across requests. */
  readonly ttlMs: number;
  /** Subjects held at most; the least recently used goes first. 0 keeps nothing across requests. */
  readonly maxEntries: number;
  /** Times the TTL. */
  readonly clock: { now(): Date };
  /** The model's name: `model:<name>` drops everything. */
  readonly model: string;
}

interface Entry {
  readonly rows: Rows;
  /** The `at` the store answered for. */
  readonly at: number;
  /** Clock time the entry stops serving. */
  readonly until: number;
}

interface Pending {
  readonly rows: Promise<Rows>;
  readonly at: number;
}

interface Snapshot {
  readonly generation: number;
  readonly at: number;
  readonly rows: Rows | Promise<Rows>;
}

const MEMO_PREFIX = '\u0000rbac:assignments:';
/** Tags whose changes cannot reach assignment rows. */
const IGNORED_PREFIXES = ['policy:', 'rule:'];
const SET_PREFIX = '%set:';

/*
 * The assignments of a principal's subjects (design §6.1.2 preload, §10.3): per request in ctx.cache
 * (L1), across requests per subject key (L2, TTL and LRU bound). Rules that keep it correct:
 * - The store answers the rows live at `at`, and rows only ever expire (an Assignment has no start
 *   time; new rows arrive with an invalidate). So rows read for `at` serve any request whose now is
 *   at or after it, and `collect` re-checks expiry against ctx.now; a request before `at` reads anew.
 * - Every invalidate moves the generation. A load that started in an older generation answers its
 *   own callers but stores nothing, and later reads never join it; a ctx.cache snapshot of an older
 *   generation is not reused.
 * - A failed load is never stored, at either level: its callers get the rejection, the next read
 *   goes to the store.
 * - Only promises and settled rows are memoised, never a placeholder.
 */
export class AssignmentCache {
  private generation = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly store: AssignmentStore, private readonly opts: AssignmentCacheOptions) {}

  /**
   * The assignments of `subjects` live at ctx.now (and possibly some that expired since), in subject
   * order: the rows themselves when the request or the cache holds every subject, else a promise.
   * @throws (rejects) when the store fails or returns a row whose subject cannot be read
   */
  read(subjects: readonly AssignmentSubject[], ctx: EvaluationContext): Rows | Promise<Rows> {
    const bySubject = new Map<string, AssignmentSubject>();
    for (const s of subjects) bySubject.set(subjectKey(s), s);
    const memoKey = MEMO_PREFIX + JSON.stringify([...bySubject.keys()]);
    const at = ctx.now.getTime();
    const memo = ctx.cache.get(memoKey) as Snapshot | undefined;
    if (memo !== undefined && memo.generation === this.generation && memo.at <= at) return memo.rows;
    const generation = this.generation;
    const rows = this.load(bySubject, ctx.now);
    if (!(rows instanceof Promise)) {
      ctx.cache.set(memoKey, { generation, at, rows });
      return rows;
    }
    const snapshot: Snapshot = { generation, at, rows };
    ctx.cache.set(memoKey, snapshot);
    rows.then(
      (value) => {
        if (ctx.cache.get(memoKey) === snapshot) ctx.cache.set(memoKey, { generation, at, rows: value });
      },
      () => {
        if (ctx.cache.get(memoKey) === snapshot) ctx.cache.delete(memoKey);
      },
    );
    return rows;
  }

  /**
   * The rows held for every subject at `at`, in subject order, without IO or waiting on a load in
   * flight: first the settled snapshot of the request in `ctx` (it outlives the TTL, a TTL of 0
   * included), else the entries across requests; undefined when any subject is missing there (not
   * preloaded, expired or invalidated).
   */
  peek(subjects: readonly AssignmentSubject[], at: Date, ctx?: EvaluationContext): Rows | undefined {
    const keys = [...new Set(subjects.map(subjectKey))];
    const memo = ctx?.cache.get(MEMO_PREFIX + JSON.stringify(keys)) as Snapshot | undefined;
    if (memo !== undefined && memo.generation === this.generation && memo.at <= at.getTime() && !(memo.rows instanceof Promise)) return memo.rows;
    const clock = this.opts.clock.now().getTime();
    const parts: Rows[] = [];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry === undefined || clock >= entry.until || clock < entry.until - this.opts.ttlMs || entry.at > at.getTime()) return undefined;
      parts.push(entry.rows);
    }
    return Object.freeze(parts.flat());
  }

  /**
   * `subject:<principalKey>` drops that subject and every subject set (a set's members change with
   * principals' assignments); `model:<this model>` drops everything; `policy:`, `rule:` and other
   * models' tags drop no entry; any other tag, a non-string tag or a non-array drops everything.
   * Every call moves the generation, so loads in flight store nothing and request snapshots are
   * read again from the entries.
   */
  invalidate(tags: readonly string[]): void {
    this.generation++;
    if (!Array.isArray(tags)) return this.clear();
    for (const tag of tags as readonly unknown[]) {
      if (typeof tag !== 'string') return this.clear();
      if (tag.startsWith('subject:')) {
        this.drop((key) => key === tag.slice('subject:'.length) || key.startsWith(SET_PREFIX));
      } else if (tag.startsWith('model:')) {
        if (tag === `model:${this.opts.model}`) return this.clear();
      } else if (!IGNORED_PREFIXES.some((p) => tag.startsWith(p))) {
        return this.clear();
      }
    }
  }

  private load(subjects: ReadonlyMap<string, AssignmentSubject>, at: Date): Rows | Promise<Rows> {
    const now = at.getTime();
    const clock = this.opts.clock.now().getTime();
    const parts = new Map<string, Rows | Promise<Rows>>();
    const missing: string[] = [];
    for (const key of subjects.keys()) {
      const entry = this.entries.get(key);
      // An entry from the future (the clock went back) would outlive its TTL.
      if (entry !== undefined && (clock >= entry.until || clock < entry.until - this.opts.ttlMs)) this.entries.delete(key);
      else if (entry !== undefined && entry.at <= now) {
        this.entries.delete(key);
        this.entries.set(key, entry);
        parts.set(key, entry.rows);
        continue;
      }
      const pending = this.pending.get(key);
      if (pending !== undefined && pending.at <= now) parts.set(key, pending.rows);
      else missing.push(key);
    }
    if (missing.length > 0) for (const [key, rows] of this.fetch(missing, subjects, at)) parts.set(key, rows);
    const ordered = [...subjects.keys()].map((key) => parts.get(key)!);
    if (!ordered.some((p) => p instanceof Promise)) return Object.freeze((ordered as Rows[]).flat());
    return Promise.all(ordered).then((all) => Object.freeze(all.flat()));
  }

  /** One store read for `keys`; its rows are stored only if no invalidate came since it started. */
  private fetch(keys: readonly string[], subjects: ReadonlyMap<string, AssignmentSubject>, at: Date): Map<string, Promise<Rows>> {
    const generation = this.generation;
    const until = this.opts.clock.now().getTime() + this.opts.ttlMs;
    const mine = new Map<string, Promise<Rows>>();
    const settle = () => {
      for (const [key, rows] of mine) if (this.pending.get(key)?.rows === rows) this.pending.delete(key);
    };
    const batch = Promise.resolve()
      .then(() =>
        this.store.forSubjects(
          keys.map((k) => subjects.get(k)!),
          at,
        ),
      )
      .then((rows) => {
        const buckets = new Map<string, Assignment[]>(keys.map((k) => [k, []]));
        // A row of a subject not asked for is dropped; a row whose subject cannot be read fails the load.
        for (const row of rows.map(frozenData)) buckets.get(subjectKey(row.subject))?.push(row);
        const out = new Map<string, Rows>([...buckets].map(([k, list]) => [k, Object.freeze(list)]));
        settle();
        if (this.generation === generation) for (const [key, list] of out) this.keep(key, { rows: list, at: at.getTime(), until });
        return out;
      });
    batch.catch(settle);
    for (const key of keys) {
      const rows = batch.then((out) => out.get(key)!);
      mine.set(key, rows);
      this.pending.set(key, { rows, at: at.getTime() });
    }
    return mine;
  }

  private keep(key: string, entry: Entry): void {
    if (this.opts.ttlMs <= 0 || this.opts.maxEntries <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.opts.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  private drop(match: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (match(key)) this.entries.delete(key);
    for (const key of [...this.pending.keys()]) if (match(key)) this.pending.delete(key);
  }

  private clear(): void {
    this.entries.clear();
    this.pending.clear();
  }
}

/**
 * A deep-frozen copy: cached rows are shared by every request, so a step that mutates one throws
 * (strict mode) instead of changing other principals' decisions. Dates are copied, not frozen (a
 * frozen Date still changes through setTime); the store keeps its own objects.
 */
function frozenData<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenData)) as T;
  if (typeof value !== 'object' || value === null) return value;
  // A copy, so the store's Date is not shared; getTime.call also reads a Date from another realm.
  if (Object.prototype.toString.call(value) === '[object Date]') return new Date(Date.prototype.getTime.call(value)) as T;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, frozenData(v)]))) as T;
}
