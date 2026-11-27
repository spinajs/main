import type { EvaluationContext } from '@spinajs/authz';
import { Perf } from '@spinajs/log-common';

import type { Assignment, AssignmentStore, AssignmentSubject } from '../contracts.js';
import { subjectKey } from './assignments.js';

type Rows = readonly Assignment[];

export const DEFAULT_ASSIGNMENTS_TTL_SECONDS = 60;
export const DEFAULT_MAX_CACHED_SUBJECTS = 10_000;
export const DEFAULT_ROLES_CHECK_SECONDS = 60;

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
  /** Order of the load that stored it; an older load never replaces it. */
  readonly started: number;
  /** The `at` the store answered for. */
  readonly at: number;
  /** Clock time the entry stops serving. */
  readonly until: number;
}

class Snapshot {
  constructor(
    readonly generation: number,
    /** Order of the read that stored it; an older read never replaces it. */
    readonly started: number,
    readonly at: number,
    readonly rows: Rows,
  ) {}
}

/** A store read in flight that readers outside a transaction may join. */
class Running {
  constructor(
    readonly rows: Promise<Rows>,
    readonly at: number,
    readonly generation: number,
  ) {}
}

const MEMO_PREFIX = '\u0000rbac:assignments:';
/** Tags whose changes cannot reach assignment rows. */
const IGNORED_PREFIXES = ['policy:', 'rule:'];
const SET_PREFIX = '%set:';

/*
 * The assignments of a principal's subjects: per request in ctx.cache,
 * and per subject key across requests (TTL and LRU bound). Rules that keep it correct:
 * - The store answers the rows live at `at`, and rows only ever expire (an Assignment has no start
 *   time; new rows arrive with an invalidate). So rows read for `at` serve any request whose now is
 *   at or after it, and `collect` re-checks expiry against ctx.now; a request before `at` reads anew.
 * - Every invalidate moves the generation. A load that started in an older generation answers its
 *   own caller but stores nothing; a ctx.cache snapshot of an older generation is not reused.
 * - Only settled rows are kept, at either level. A read that finds no settled rows joins a load in
 *   flight only when the store answered inTransaction() === false for that load and for the reader,
 *   the load's `at` is not after the reader's and no invalidate came since it started; otherwise it
 *   loads for itself. Inside a transaction a load is never shared: a caller in a savepoint that
 *   awaited a load another caller issued on the enclosing level would wait for a statement queued
 *   behind its own savepoint. A store that cannot answer shares nothing.
 * - A load the store says ran inside a transaction fills only its request: the transaction may roll back.
 * - A failed load is never stored: its caller and the readers that joined it get the rejection, the
 *   next read goes to the store.
 */
export class AssignmentCache {
  private generation = 0;
  private loads = 0;
  private reads = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Map<string, Running>();

  constructor(private readonly store: AssignmentStore, private readonly opts: AssignmentCacheOptions) {}

  /**
   * The assignments of `subjects` live at ctx.now (and possibly some that expired since), in subject
   * order: the rows themselves when the request or the cache holds every subject, else a promise.
   * `opts.fresh` skips the request memo and every cached copy; the rows it reads refresh both.
   * @throws (rejects) when the store fails or returns a row whose subject cannot be read
   */
  read(subjects: readonly AssignmentSubject[], ctx: EvaluationContext, opts: { readonly fresh?: boolean } = {}): Rows | Promise<Rows> {
    const bySubject = new Map<string, AssignmentSubject>();
    for (const s of subjects) bySubject.set(subjectKey(s), s);
    const memoKey = MEMO_PREFIX + JSON.stringify([...bySubject.keys()]);
    const at = ctx.now.getTime();
    const memo = ctx.cache.get(memoKey);
    if (opts.fresh !== true && memo instanceof Snapshot && memo.generation === this.generation && memo.at <= at) {
      Perf.count('authz.rbac.assignments.hit');
      return memo.rows;
    }
    const generation = this.generation;
    const started = ++this.reads;
    const keep = (value: Rows): Rows => {
      const current = ctx.cache.get(memoKey);
      if (this.generation === generation && !(current instanceof Snapshot && current.generation === generation && current.started > started)) ctx.cache.set(memoKey, new Snapshot(generation, started, at, value));
      return value;
    };
    const rows = this.load(bySubject, ctx.now, opts.fresh === true);
    return rows instanceof Promise ? rows.then(keep) : keep(rows);
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

  private load(subjects: ReadonlyMap<string, AssignmentSubject>, at: Date, fresh = false): Rows | Promise<Rows> {
    let inside: boolean | undefined;
    try {
      inside = this.store.inTransaction?.();
    } catch (err) {
      return rejected(err);
    }
    const now = at.getTime();
    const clock = this.opts.clock.now().getTime();
    const parts = new Map<string, Rows | Promise<Rows>>();
    const missing: string[] = [];
    for (const key of subjects.keys()) {
      const part = fresh ? undefined : (this.cached(key, now, clock) ?? (inside === false ? this.joinable(key, now) : undefined));
      if (part === undefined) missing.push(key);
      else parts.set(key, part);
    }
    Perf.count(missing.length > 0 ? 'authz.rbac.assignments.miss' : 'authz.rbac.assignments.hit');
    if (missing.length > 0) for (const [key, rows] of this.fetch(missing, subjects, at, inside)) parts.set(key, rows);
    const ordered = [...subjects.keys()].map((key) => parts.get(key)!);
    const settled = ordered.filter((part): part is Rows => !(part instanceof Promise));
    if (settled.length === ordered.length) return Object.freeze(settled.flat());
    return Promise.all(ordered).then((all) => Object.freeze(all.flat()));
  }

  /** The entry's rows when it is live on the clock and loaded at or before `now`; marks it recently used. */
  private cached(key: string, now: number, clock: number): Rows | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // An entry from the future (the clock went back) would outlive its TTL.
    if (clock >= entry.until || clock < entry.until - this.opts.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    if (entry.at > now) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.rows;
  }

  /** The rows of a load outside a transaction still running for `key`, started in this generation at or before `now`. */
  private joinable(key: string, now: number): Promise<Rows> | undefined {
    const run = this.running.get(key);
    return run !== undefined && run.generation === this.generation && run.at <= now ? run.rows : undefined;
  }

  /**
   * One store read for `keys`, a promise per key. Its rows are stored only if no invalidate came since
   * it started and the store did not say it ran inside a transaction; a read outside one can be joined.
   */
  private fetch(keys: readonly string[], subjects: ReadonlyMap<string, AssignmentSubject>, at: Date, inside: boolean | undefined): Map<string, Promise<Rows>> {
    const generation = this.generation;
    const started = ++this.loads;
    const until = this.opts.clock.now().getTime() + this.opts.ttlMs;
    const batch = (async () => {
      const rows = await this.store.forSubjects(
        keys.map((k) => subjects.get(k)!),
        at,
      );
      const buckets = new Map<string, Assignment[]>(keys.map((k) => [k, []]));
      // A row of a subject not asked for is dropped; a row whose subject cannot be read fails the load.
      for (const row of rows.map(frozenData)) buckets.get(subjectKey(row.subject))?.push(row);
      const out = new Map<string, Rows>([...buckets].map(([k, list]) => [k, Object.freeze(list)]));
      if (this.generation === generation && inside !== true) for (const [key, list] of out) this.keep(key, { rows: list, started, at: at.getTime(), until });
      return out;
    })();
    const mine = new Map(keys.map((key) => [key, batch.then((out) => out.get(key)!)]));
    if (inside === false) {
      for (const [key, rows] of mine) {
        const run = new Running(rows, at.getTime(), generation);
        this.running.set(key, run);
        rows.then(
          () => this.finished(key, run),
          () => this.finished(key, run),
        );
      }
    }
    return mine;
  }

  private finished(key: string, run: Running): void {
    if (this.running.get(key) === run) this.running.delete(key);
  }

  private keep(key: string, entry: Entry): void {
    if (this.opts.ttlMs <= 0 || this.opts.maxEntries <= 0) return;
    if ((this.entries.get(key)?.started ?? 0) > entry.started) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.opts.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  private drop(match: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (match(key)) this.entries.delete(key);
  }

  private clear(): void {
    this.entries.clear();
  }
}

/** `err` as a rejection, whatever was thrown: `read` fails by rejecting, never by throwing. */
async function rejected(err: unknown): Promise<never> {
  throw err;
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
