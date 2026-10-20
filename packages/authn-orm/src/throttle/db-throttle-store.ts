import { backoffDelayMs } from '@spinajs/authn/contracts';
import type { BackoffParams } from '@spinajs/authn/contracts';
import { ormReady } from '@spinajs/orm';
import type { WhereBuilder } from '@spinajs/orm';
import type { KeyedBackoffVerdict, ThrottleGate, ThrottleLower, ThrottleStore } from '@spinajs/util';
import type { DateTime } from 'luxon';

import { AuthnThrottle } from '../models/AuthnThrottle.js';
import { instant, isDuplicate } from '../support/sql.js';

/** Each miss means another attempt won that key, so this bounds the parallel attempts one call waits behind. */
const MAX_TRIES = 64;
const PURGE_EVERY = 64;
const PURGE_BATCH = 500;
const FAIL_CLOSED_MS = 1000;

/** @internal "now" and the staleness cutoff of one call. */
export interface StoreTimes {
  readonly nowMs: number;
  readonly now: DateTime;
  readonly cutoff: DateTime;
}

/** @internal A live row as stored: its datetimes as read back, so a write can compare against them. */
export interface ClaimState {
  readonly attempts: number;
  readonly last: DateTime;
  readonly next: DateTime;
}

/** @internal What a claim wrote. `prev` is the live row it replaced; without one (insert or stale row) undo deletes the row. */
export interface ClaimWrite {
  readonly k: string;
  readonly attempts: number;
  readonly last: DateTime;
  readonly next: DateTime;
  readonly prev?: ClaimState;
}

/** @internal */
export type Claimed = { readonly ok: true; readonly write: ClaimWrite } | { readonly ok: false; readonly waitMs: number };

export interface DbThrottleStoreOptions {
  /** A row idle this long that delays nobody counts as zero and may be purged. */
  readonly resetAfterMs: number;
}

/**
 * The rows of `DbAuthnThrottle` in `authn_throttle`, shared by every app instance. Each attempt claims its slot on
 * every gating key with a compare-and-set; a later key that refuses undoes the earlier claims in reverse. No
 * transactions: the sqlite driver shares one handle, so a transaction would take in the statements of concurrent
 * attempts. `succeed` is several compare-and-set statements too, where a lost race only throttles more.
 *
 * Every time decision compares in SQL against the `nowMs` passed in, never SQL `now()`, and never against a datetime
 * read back (lane note D10). Flows need no column: the ids already differ per flow.
 */
export class DbThrottleStore implements ThrottleStore {
  private readonly resetAfterMs: number;
  private attempts = 0;

  constructor(options: DbThrottleStoreOptions) {
    this.resetAfterMs = options.resetAfterMs;
  }

  public async attempt(_flow: string, gates: readonly ThrottleGate[], counted: readonly string[], nowMs: number): Promise<KeyedBackoffVerdict> {
    await ormReady();
    if (++this.attempts % PURGE_EVERY === 0) {
      await this.purge(nowMs);
    }

    const t = this.times(nowMs);
    const backoff = new Map(gates.map((g) => [g.id, g.backoff]));
    const order = [...backoff.keys()].sort();
    if (order.length > 0) {
      const waitMs = await this.blockedWait(order, t);
      if (waitMs > 0) return this.refuse(waitMs);
    }

    const live = await this.readLive([...order, ...counted], t);
    const claims: ClaimWrite[] = [];
    for (const [i, k] of order.entries()) {
      const p = backoff.get(k)!;
      const r = await this.claimKey(k, (n) => backoffDelayMs(p, n), live.get(k), t, order.slice(i + 1));
      if (!r.ok) {
        await this.undo(claims, t);
        return this.refuse(r.waitMs);
      }
      claims.push(r.write);
    }
    for (const k of counted) {
      await this.countBook(k, live.get(k), t);
    }
    return { allowed: true };
  }

  public async peek(_flow: string, gates: readonly ThrottleGate[], nowMs: number): Promise<KeyedBackoffVerdict> {
    if (gates.length === 0) return { allowed: true };
    await ormReady();
    const waitMs = await this.blockedWait(gates.map((g) => g.id).sort(), this.times(nowMs));
    return waitMs > 0 ? this.refuse(waitMs) : { allowed: true };
  }

  /** Lowers by the largest count it consumed: rows carry no run, so a `by` row older than its target is taken off too. */
  public async succeed(_flow: string, lower: readonly ThrottleLower[], clear: readonly string[], nowMs: number): Promise<void> {
    await ormReady();
    const t = this.times(nowMs);
    const consumed = new Set<string>();
    for (const { targets, by } of lower) {
      let spent = 0;
      for (const k of by) {
        consumed.add(k);
        spent = Math.max(spent, await this.takeBook(k, t));
      }
      if (spent === 0) continue;
      for (const { id, backoff } of targets) {
        await this.subtract(id, backoff, spent, t);
      }
    }
    // A consumed row is not deleted again: a count an attempt added to it since stays for the next success.
    for (const k of clear) {
      if (!consumed.has(k)) await AuthnThrottle.destroy().where('k', k);
    }
  }

  /** Deletes up to one batch of stale rows (idle for resetAfterMs and delaying nobody); returns how many went. */
  public async purge(nowMs: number): Promise<number> {
    await ormReady();
    const t = this.times(nowMs);
    // MSSQL pages with OFFSET … FETCH, which needs an ORDER BY.
    const stale = await AuthnThrottle.query().columns(['k']).where('last_attempt_at', '<=', t.cutoff).where('next_allowed_at', '<=', t.now).orderBy('k').take(PURGE_BATCH);
    if (stale.length === 0) return 0;
    const { RowsAffected } = await AuthnThrottle.destroy()
      .whereIn(
        'k',
        stale.map((r) => r.k),
      )
      .where('last_attempt_at', '<=', t.cutoff)
      .where('next_allowed_at', '<=', t.now);
    return RowsAffected;
  }

  /**
   * @internal Claims one gating key: counts attempt n + 1 and sets its next allowed time, or reports the wait. A miss
   * re-reads this key and the keys still to claim (`rest`): an attempt that will be refused further on stops here,
   * before it adds counts that its undo may no longer take back.
   */
  protected async claimKey(k: string, delay: (n: number) => number, state: ClaimState | undefined, t: StoreTimes, rest: readonly string[] = []): Promise<Claimed> {
    for (let i = 0; i < MAX_TRIES; i++) {
      const attempts = (state?.attempts ?? 0) + 1;
      const write: ClaimWrite = { k, attempts, last: t.now, next: instant(t.nowMs + delay(attempts)), prev: state };
      if (state ? await this.writeLive(write, state.attempts, t) : await this.insertOrTakeStale(write, t)) {
        return { ok: true, write };
      }
      const waitMs = await this.blockedWait([k, ...rest], t);
      if (waitMs > 0) return { ok: false, waitMs };
      state = (await this.readLive([k], t)).get(k);
    }
    return { ok: false, waitMs: FAIL_CLOSED_MS };
  }

  /** @internal CAS on a live row that delays nobody now. */
  protected async writeLive(w: ClaimWrite, n: number, t: StoreTimes): Promise<boolean> {
    const r = await AuthnThrottle.update({ attempts: w.attempts, last_attempt_at: w.last, next_allowed_at: w.next, updated_at: t.now }).where('k', w.k).where('attempts', n).where('next_allowed_at', '<=', t.now).where('last_attempt_at', '>', t.cutoff);
    return r.RowsAffected === 1;
  }

  /** @internal Inserts the first count; a row already there may be taken over only when stale (it counts as zero). */
  protected async insertOrTakeStale(w: ClaimWrite, t: StoreTimes): Promise<boolean> {
    try {
      await AuthnThrottle.insert({ k: w.k, attempts: w.attempts, last_attempt_at: w.last, next_allowed_at: w.next, updated_at: t.now });
      return true;
    } catch (err) {
      if (!isDuplicate(err)) throw err;
    }
    const r = await AuthnThrottle.update({ attempts: w.attempts, last_attempt_at: w.last, next_allowed_at: w.next, updated_at: t.now }).where('k', w.k).where('next_allowed_at', '<=', t.now).where('last_attempt_at', '<=', t.cutoff);
    return r.RowsAffected === 1;
  }

  /** @internal Puts back what each claim replaced, only where the row still holds exactly what it wrote; a miss keeps the count. */
  protected async undo(claims: readonly ClaimWrite[], t: StoreTimes): Promise<void> {
    for (const w of [...claims].reverse()) {
      if (w.prev) {
        await AuthnThrottle.update({ attempts: w.prev.attempts, last_attempt_at: w.prev.last, next_allowed_at: w.prev.next, updated_at: t.now }).where('k', w.k).where('attempts', w.attempts).where('last_attempt_at', w.last).where('next_allowed_at', w.next);
      } else {
        await AuthnThrottle.destroy().where('k', w.k).where('attempts', w.attempts).where('last_attempt_at', w.last).where('next_allowed_at', w.next);
      }
    }
  }

  /** A counted row gates nothing, so a lost race here only leaves less to subtract on success (more throttling). */
  private async countBook(k: string, state: ClaimState | undefined, t: StoreTimes): Promise<void> {
    for (let i = 0; i < MAX_TRIES; i++) {
      const write: ClaimWrite = { k, attempts: (state?.attempts ?? 0) + 1, last: t.now, next: t.now };
      if (state ? await this.writeLive(write, state.attempts, t) : await this.insertOrTakeStale(write, t)) return;
      state = (await this.readLive([k], t)).get(k);
    }
  }

  /** Deletes a live counted row; the caller that deleted it gets its count. */
  private async takeBook(k: string, t: StoreTimes): Promise<number> {
    for (let i = 0; i < MAX_TRIES; i++) {
      const state = (await this.readLive([k], t)).get(k);
      if (!state) return 0;
      const r = await AuthnThrottle.destroy().where('k', k).where('attempts', state.attempts).where(this.isLive(t));
      if (r.RowsAffected === 1) return state.attempts;
    }
    return 0;
  }

  private async subtract(k: string, p: BackoffParams, spent: number, t: StoreTimes): Promise<void> {
    for (let i = 0; i < MAX_TRIES; i++) {
      const state = (await this.readLive([k], t)).get(k);
      if (!state) return;
      const attempts = Math.max(0, state.attempts - spent);
      let r: { RowsAffected: number };
      if (attempts === 0) {
        r = await AuthnThrottle.destroy().where('k', k).where('attempts', state.attempts).where(this.isLive(t));
      } else {
        // The schedule runs from the row's last counted attempt.
        const lastMs = state.last?.toMillis() ?? NaN;
        const next = Number.isFinite(lastMs) ? instant(lastMs + backoffDelayMs(p, attempts)) : state.next;
        r = await AuthnThrottle.update({ attempts, next_allowed_at: next, updated_at: t.now }).where('k', k).where('attempts', state.attempts).where(this.isLive(t));
      }
      if (r.RowsAffected === 1) return;
    }
  }

  /** The longest wait any of `ks` imposes now, 0 when none delays. */
  private async blockedWait(ks: readonly string[], t: StoreTimes): Promise<number> {
    const rows = await AuthnThrottle.query()
      .columns(['k', 'next_allowed_at'])
      .whereIn('k', [...ks])
      .where('next_allowed_at', '>', t.now);
    let waitMs = 0;
    for (const r of rows) {
      const ms = (r.next_allowed_at?.toMillis() ?? NaN) - t.nowMs;
      // A delaying row whose datetime does not read still delays.
      waitMs = Math.max(waitMs, Number.isFinite(ms) && ms > 0 ? ms : FAIL_CLOSED_MS);
    }
    return waitMs;
  }

  /** Rows of `ks` that are not stale; stale and missing rows both count as zero. */
  private async readLive(ks: readonly string[], t: StoreTimes): Promise<Map<string, ClaimState>> {
    const out = new Map<string, ClaimState>();
    if (ks.length === 0) return out;
    const rows = await AuthnThrottle.query()
      .columns(['k', 'attempts', 'last_attempt_at', 'next_allowed_at'])
      .whereIn('k', [...ks])
      .where(this.isLive(t));
    for (const r of rows) {
      out.set(r.k, { attempts: Number(r.attempts), last: r.last_attempt_at, next: r.next_allowed_at });
    }
    return out;
  }

  // Stale: idle for resetAfterMs and delaying nobody; a delay longer than that still runs to its end.
  private isLive(t: StoreTimes) {
    return function (this: WhereBuilder<unknown>) {
      this.where('last_attempt_at', '>', t.cutoff);
      this.orWhere('next_allowed_at', '>', t.now);
    };
  }

  private refuse(waitMs: number): KeyedBackoffVerdict {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  private times(nowMs: number): StoreTimes {
    return { nowMs, now: instant(nowMs), cutoff: instant(nowMs - this.resetAfterMs) };
  }
}
