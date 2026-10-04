import { createHmac } from 'node:crypto';

import { AuthnThrottle } from '@spinajs/authn/contracts';
import type { AuthnContext, ThrottleFlow, ThrottleKey } from '@spinajs/authn/contracts';
import { Configuration } from '@spinajs/configuration';
import { DI, IContainer, Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { Log } from '@spinajs/log';
import { Orm, OrmDriver } from '@spinajs/orm';
import type { RawQuery, WhereBuilder } from '@spinajs/orm';

import { checkedMs, columnText, driverDialect, isDuplicate, rowsAffected, selectTime, sqlTime, textMs } from '../support/sql.js';
import type { Dialect } from '../support/sql.js';
import { THROTTLE_FLOWS, backoffDelayMs, checkThrottleParams, readThrottleConfig } from './params.js';
import type { BackoffParams, ThrottleFlowParams, ThrottleParams } from './params.js';

const TABLE = 'authn_throttle';
/** Each miss means another attempt won that key, so this bounds the parallel attempts one call waits behind. */
const MAX_TRIES = 64;
const PURGE_EVERY = 64;
const PURGE_BATCH = 500;
const FAIL_CLOSED_MS = 1000;
// Without authn.audit.hashKey the row key is a hash under this public constant: no raw value is stored, but a
// known login can be tested against it.
const DEFAULT_HASH_KEY = 'spinajs:authn-orm:throttle';

type Verdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** @internal "now" and the staleness cutoff of one call, as UTC wall-clock text in the column format. */
export interface StoreTimes {
  readonly nowMs: number;
  readonly now: string;
  readonly cutoff: string;
}

/** @internal A live row as stored; datetimes are read as text, so they come back exactly as written. */
export interface ClaimState {
  readonly attempts: number;
  readonly last: string;
  readonly next: string;
}

/** @internal What a claim wrote. `prev` is the live row it replaced; without one (insert or stale row) undo deletes the row. */
export interface ClaimWrite {
  readonly k: string;
  readonly attempts: number;
  readonly last: string;
  readonly next: string;
  readonly prev?: ClaimState;
}

/** @internal */
export type Claimed = { readonly ok: true; readonly write: ClaimWrite } | { readonly ok: false; readonly waitMs: number };

export interface DbThrottleOptions {
  /** Overrides `authn.audit.hashKey.secret`; null uses the built-in constant. */
  readonly hashKey?: string | null;
  /** Where the Orm and the Configuration come from; default the root container. */
  readonly container?: IContainer;
}

/**
 * Backoff per key, never a lock (A05, A06, H31), in `authn_throttle`, shared by every app instance. Each attempt
 * claims its slot on every gating key with a compare-and-set before anything is verified. No transactions: the
 * sqlite driver shares one handle, so a transaction would take in the statements of concurrent attempts. Steps
 * are single-statement compare-and-sets instead, undone in reverse when a later key refuses.
 *
 * Every time decision compares in SQL against values computed in Node (`ctx.now`, or the clock in `succeed`),
 * never SQL `now()`, and never against a datetime read back (lane note D10).
 *
 * Tested on sqlite and postgres. On MySQL and MSSQL the migration's `datetime` keeps whole seconds (MySQL) or
 * about 3 ms (MSSQL): undo may then miss, which keeps the extra count (more throttling), and a `baseDelayMs`
 * below one second is not supported there.
 *
 * `last_attempt_at` takes the caller's now, not the later of the two: with clocks skewed across instances, an
 * account-ip row can outlive the ip run it counted in by that skew, and a later success subtracts it from the new run.
 */
@Singleton()
@Injectable(AuthnThrottle)
export class DbAuthnThrottle extends AuthnThrottle {
  private readonly explicitParams: ThrottleParams | undefined;
  private loadedParams: ThrottleParams | undefined;
  private hmacKey: Buffer | undefined;
  private dialect: Dialect = 'other';
  private loading: Promise<void> | undefined;
  private attempts = 0;

  /**
   * DI passes nothing: the `'default'` connection, `authn.throttle` and `authn.audit.hashKey.secret` come from the
   * container on first use (`init`). With a driver and no container nothing is read from the configuration:
   * `params` default to §22.5 and the hash key to `options.hashKey`.
   */
  constructor(private driver?: OrmDriver, params?: ThrottleParams, private readonly options: DbThrottleOptions = {}) {
    super();
    this.explicitParams = params === undefined ? undefined : checkThrottleParams(params);
    if (!this.usesConfiguration()) {
      this.loadedParams = this.explicitParams ?? readThrottleConfig(undefined);
      this.hmacKey = hashKeyOf(this.options.hashKey);
    }
  }

  public get params(): ThrottleParams {
    if (!this.loadedParams) throw new InvalidOption('DbAuthnThrottle: params are read from the configuration; await init() first');
    return this.loadedParams;
  }

  /** Resolves the connection and the configuration; `attempt`, `succeed` and `purge` call it first. */
  public async init(): Promise<void> {
    this.loading ??= this.load().catch((err: unknown) => {
      this.loading = undefined;
      throw err;
    });
    await this.loading;
  }

  /** The row key: base64url(HMAC-SHA256(hash key, `flow|kind|value`)); logins and addresses are personal data (SR-19). */
  public rowKey(flow: ThrottleFlow, key: ThrottleKey): string {
    if (typeof key?.value !== 'string') {
      throw new InvalidArgument(`DbAuthnThrottle: the value of a ${JSON.stringify(String(key?.kind))} key must be a string`);
    }
    if (!this.hmacKey) throw new InvalidOption('DbAuthnThrottle: the hash key is read from the configuration; await init() first');
    return createHmac('sha256', this.hmacKey)
      .update(`${flow}|${String(key.kind)}|${key.value}`, 'utf8')
      .digest('base64url');
  }

  public async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<Verdict> {
    const now = ctx?.now;
    const nowMs = checkedMs(now, 'DbAuthnThrottle.attempt: ctx.now');
    await this.init();
    const f = this.flowParams(flow);
    const gates = new Map<string, BackoffParams>();
    const books = new Set<string>();
    for (const key of keys) {
      const k = this.rowKey(flow, key);
      const p = this.gateParams(f, key.kind);
      if (p) gates.set(k, p);
      else if (key.kind === 'account-ip' && f.ip) books.add(k);
    }

    const db = this.driver!;
    if (++this.attempts % PURGE_EVERY === 0) {
      await this.purge(now);
    }

    const t = this.times(nowMs);
    const order = [...gates.keys()].sort();
    if (order.length > 0) {
      const waitMs = await this.blockedWait(db, order, t);
      if (waitMs > 0) return this.refuse(waitMs);
    }

    const live = await this.readLive(db, [...order, ...books], t);
    const claims: ClaimWrite[] = [];
    for (const [i, k] of order.entries()) {
      const p = gates.get(k)!;
      const r = await this.claimKey(db, k, (n) => backoffDelayMs(p, n), live.get(k), t, order.slice(i + 1));
      if (!r.ok) {
        await this.undo(db, claims, t);
        return this.refuse(r.waitMs);
      }
      claims.push(r.write);
    }
    for (const k of books) {
      await this.countBook(db, k, live.get(k), t);
    }
    return { allowed: true };
  }

  public async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<void> {
    await this.init();
    const f = this.flowParams(flow);
    const rows = keys.map((key) => ({ kind: key?.kind, k: this.rowKey(flow, key) }));
    if (flow === 'reset') return;

    const db = this.driver!;
    const t = this.times(Date.now());
    let spent = 0;
    for (const k of new Set(rows.filter((r) => r.kind === 'account-ip').map((r) => r.k))) {
      spent = Math.max(spent, await this.takeBook(db, k, t));
    }
    if (f.ip && spent > 0) {
      for (const k of new Set(rows.filter((r) => r.kind === 'ip').map((r) => r.k))) {
        await this.subtract(db, k, f.ip, spent, t);
      }
    }
    for (const r of rows) {
      if (r.kind === 'account') await db.del().from(TABLE).where('k', r.k);
    }
  }

  /** Deletes up to one batch of stale rows (idle for resetAfterSeconds and delaying nobody); returns how many went. */
  public async purge(now: Date = new Date()): Promise<number> {
    const nowMs = checkedMs(now, 'DbAuthnThrottle.purge: now');
    await this.init();
    const db = this.driver!;
    const t = this.times(nowMs);
    // MSSQL pages with OFFSET … FETCH, which needs an ORDER BY.
    const stale = (await db.select().from(TABLE).select('k').where('last_attempt_at', '<=', t.cutoff).where('next_allowed_at', '<=', t.now).orderBy('k').take(PURGE_BATCH)) as { k: string }[];
    if (stale.length === 0) return 0;
    return rowsAffected(
      await db
        .del()
        .from(TABLE)
        .whereIn(
          'k',
          stale.map((r) => r.k),
        )
        .where('last_attempt_at', '<=', t.cutoff)
        .where('next_allowed_at', '<=', t.now),
    );
  }

  /**
   * @internal Claims one gating key: counts attempt n + 1 and sets its next allowed time, or reports the wait. A miss
   * re-reads this key and the keys still to claim (`rest`): an attempt that will be refused further on stops here,
   * before it adds counts that its undo may no longer take back.
   */
  protected async claimKey(db: OrmDriver, k: string, delay: (n: number) => number, state: ClaimState | undefined, t: StoreTimes, rest: readonly string[] = []): Promise<Claimed> {
    for (let i = 0; i < MAX_TRIES; i++) {
      const attempts = (state?.attempts ?? 0) + 1;
      const write: ClaimWrite = { k, attempts, last: t.now, next: sqlTime(t.nowMs + delay(attempts)), prev: state };
      if (state ? await this.writeLive(db, write, state.attempts, t) : await this.insertOrTakeStale(db, write, t)) {
        return { ok: true, write };
      }
      const waitMs = await this.blockedWait(db, [k, ...rest], t);
      if (waitMs > 0) return { ok: false, waitMs };
      state = (await this.readLive(db, [k], t)).get(k);
    }
    return { ok: false, waitMs: FAIL_CLOSED_MS };
  }

  /** @internal CAS on a live row that delays nobody now. */
  protected async writeLive(db: OrmDriver, w: ClaimWrite, n: number, t: StoreTimes): Promise<boolean> {
    const r = await db.update().in(TABLE).update({ attempts: w.attempts, last_attempt_at: w.last, next_allowed_at: w.next, updated_at: t.now }).where('k', w.k).where('attempts', n).where('next_allowed_at', '<=', t.now).where('last_attempt_at', '>', t.cutoff);
    return rowsAffected(r) === 1;
  }

  /** @internal Inserts the first count; a row already there may be taken over only when stale (it counts as zero). */
  protected async insertOrTakeStale(db: OrmDriver, w: ClaimWrite, t: StoreTimes): Promise<boolean> {
    try {
      await db.insert().into(TABLE).values({ k: w.k, attempts: w.attempts, last_attempt_at: w.last, next_allowed_at: w.next, updated_at: t.now });
      return true;
    } catch (err) {
      if (!isDuplicate(err)) throw err;
    }
    const r = await db.update().in(TABLE).update({ attempts: w.attempts, last_attempt_at: w.last, next_allowed_at: w.next, updated_at: t.now }).where('k', w.k).where('next_allowed_at', '<=', t.now).where('last_attempt_at', '<=', t.cutoff);
    return rowsAffected(r) === 1;
  }

  /** @internal Puts back what each claim replaced, only where the row still holds exactly what it wrote; a miss keeps the count. */
  protected async undo(db: OrmDriver, claims: readonly ClaimWrite[], t: StoreTimes): Promise<void> {
    for (const w of [...claims].reverse()) {
      if (w.prev) {
        await db.update().in(TABLE).update({ attempts: w.prev.attempts, last_attempt_at: w.prev.last, next_allowed_at: w.prev.next, updated_at: t.now }).where('k', w.k).where('attempts', w.attempts).where('last_attempt_at', w.last).where('next_allowed_at', w.next);
      } else {
        await db.del().from(TABLE).where('k', w.k).where('attempts', w.attempts).where('last_attempt_at', w.last).where('next_allowed_at', w.next);
      }
    }
  }

  /** account-ip gates nothing, so a lost race here only leaves less to subtract on success (more throttling). */
  private async countBook(db: OrmDriver, k: string, state: ClaimState | undefined, t: StoreTimes): Promise<void> {
    for (let i = 0; i < MAX_TRIES; i++) {
      const write: ClaimWrite = { k, attempts: (state?.attempts ?? 0) + 1, last: t.now, next: t.now };
      if (state ? await this.writeLive(db, write, state.attempts, t) : await this.insertOrTakeStale(db, write, t)) return;
      state = (await this.readLive(db, [k], t)).get(k);
    }
  }

  /** Deletes a live account-ip row; the caller that deleted it gets its count. */
  private async takeBook(db: OrmDriver, k: string, t: StoreTimes): Promise<number> {
    for (let i = 0; i < MAX_TRIES; i++) {
      const state = (await this.readLive(db, [k], t)).get(k);
      if (!state) return 0;
      const r = await db.del().from(TABLE).where('k', k).where('attempts', state.attempts).where(this.isLive(t));
      if (rowsAffected(r) === 1) return state.attempts;
    }
    return 0;
  }

  private async subtract(db: OrmDriver, k: string, p: BackoffParams, spent: number, t: StoreTimes): Promise<void> {
    for (let i = 0; i < MAX_TRIES; i++) {
      const state = (await this.readLive(db, [k], t)).get(k);
      if (!state) return;
      const attempts = Math.max(0, state.attempts - spent);
      let r: unknown;
      if (attempts === 0) {
        r = await db.del().from(TABLE).where('k', k).where('attempts', state.attempts).where(this.isLive(t));
      } else {
        // The schedule runs from the row's last counted attempt, read as text, so it is exact.
        const lastMs = textMs(state.last);
        const next = Number.isFinite(lastMs) ? sqlTime(lastMs + backoffDelayMs(p, attempts)) : state.next;
        r = await db.update().in(TABLE).update({ attempts, next_allowed_at: next, updated_at: t.now }).where('k', k).where('attempts', state.attempts).where(this.isLive(t));
      }
      if (rowsAffected(r) === 1) return;
    }
  }

  /** The longest wait any of `ks` imposes now, 0 when none delays. */
  private async blockedWait(db: OrmDriver, ks: readonly string[], t: StoreTimes): Promise<number> {
    const rows = (await this.withTimes(db.select().from(TABLE).select('k'), 'next_allowed_at', 'next_text')
      .whereIn('k', [...ks])
      .where('next_allowed_at', '>', t.now)) as Record<string, unknown>[];
    let waitMs = 0;
    for (const r of rows) {
      const ms = textMs(this.textOf(r, 'next_allowed_at', 'next_text')) - t.nowMs;
      // A delaying row whose text does not parse still delays.
      waitMs = Math.max(waitMs, Number.isFinite(ms) && ms > 0 ? ms : FAIL_CLOSED_MS);
    }
    return waitMs;
  }

  /** Rows of `ks` that are not stale; stale and missing rows both count as zero. */
  private async readLive(db: OrmDriver, ks: readonly string[], t: StoreTimes): Promise<Map<string, ClaimState>> {
    const out = new Map<string, ClaimState>();
    if (ks.length === 0) return out;
    const query = this.withTimes(this.withTimes(db.select().from(TABLE).select('k').select('attempts'), 'last_attempt_at', 'last_text'), 'next_allowed_at', 'next_text');
    const rows = (await query.whereIn('k', [...ks]).where(this.isLive(t))) as Record<string, unknown>[];
    for (const r of rows) {
      out.set(String(r.k), { attempts: Number(r.attempts), last: this.textOf(r, 'last_attempt_at', 'last_text'), next: this.textOf(r, 'next_allowed_at', 'next_text') });
    }
    return out;
  }

  private withTimes<Q extends { select(column: string | RawQuery): Q }>(query: Q, column: string, alias: string): Q {
    return selectTime(this.dialect, query, column, alias);
  }

  private textOf(row: Record<string, unknown>, column: string, alias: string): string {
    return columnText(this.dialect, row, column, alias) ?? String(row[alias] ?? row[column]);
  }

  // Stale: idle for resetAfterSeconds and delaying nobody; a delay longer than that still runs to its end.
  private isLive(t: StoreTimes) {
    return function (this: WhereBuilder<unknown>) {
      this.where('last_attempt_at', '>', t.cutoff);
      this.orWhere('next_allowed_at', '>', t.now);
    };
  }

  private refuse(waitMs: number): Verdict {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  private times(nowMs: number): StoreTimes {
    return { nowMs, now: sqlTime(nowMs), cutoff: sqlTime(nowMs - this.params.resetAfterSeconds * 1000) };
  }

  private flowParams(flow: ThrottleFlow): ThrottleFlowParams {
    if (!THROTTLE_FLOWS.includes(flow)) throw new InvalidArgument(`DbAuthnThrottle: unknown flow ${JSON.stringify(String(flow))}`);
    return this.params[flow];
  }

  private gateParams(f: ThrottleFlowParams, kind: ThrottleKey['kind']): BackoffParams | undefined {
    if (kind === 'account') return f.account;
    if (kind === 'ip') return f.ip;
    if (kind === 'global') return this.params.global ?? undefined;
    return undefined;
  }

  private usesConfiguration(): boolean {
    return this.driver === undefined || this.options.container !== undefined;
  }

  private async load(): Promise<void> {
    const container = this.options.container ?? DI.RootContainer;
    if (this.usesConfiguration()) {
      const config = await container.resolve(Configuration);
      this.loadedParams = this.explicitParams ?? readThrottleConfig(config.get('authn.throttle'));
      const secret = this.options.hashKey !== undefined ? this.options.hashKey : config.get<string | null>('authn.audit.hashKey.secret');
      this.hmacKey = hashKeyOf(secret);
      if (typeof secret !== 'string' || secret.length === 0) {
        warnOnce('DbAuthnThrottle: authn.audit.hashKey.secret is not set, so throttle row keys are hashed under a public constant; anyone reading authn_throttle can test guessed logins and IPs against them');
      }
    }
    if (!this.driver) {
      const orm = await container.resolve(Orm);
      const driver = orm.Connections.get('default');
      if (!driver) throw new InvalidOption("DbAuthnThrottle: the Orm has no 'default' connection");
      this.driver = driver;
    }
    this.dialect = driverDialect(this.driver);
  }
}

let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  try {
    if (DI.check(Log)) {
      (DI.resolve(Log, ['authn-orm']) as Log).warn(message);
      return;
    }
  } catch {
    // no usable Log: fall back to the console
  }
  console.warn(message);
}

function hashKeyOf(secret: unknown): Buffer {
  return Buffer.from(typeof secret === 'string' && secret.length > 0 ? secret : DEFAULT_HASH_KEY, 'utf8');
}
