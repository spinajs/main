import { createHmac, randomBytes } from 'node:crypto';

import { DI, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { Log } from '@spinajs/log-common';
import { deepFreeze } from '@spinajs/util';

import { AuthnThrottle } from '../contracts/throttle.js';
import type { ThrottleFlow, ThrottleKey } from '../contracts/throttle.js';
import type { AuthnContext } from '../contracts/credentials.js';
import { THROTTLE_FLOWS, backoffDelayMs } from '../contracts/throttle.js';
import type { BackoffParams, ThrottleFlowParams, ThrottleParams } from '../contracts/throttle.js';
import { checkThrottleMaxRows, checkThrottleParams } from '../service/boot/env.js';
import { DEFAULT_THROTTLE_MAX_ROWS } from './params.js';
import type { ThrottleConfig } from './params.js';
import type { PeekableThrottle } from './peek.js';

// TODO: move generig throttle code into spinajs/utils ( like resilience implementation )
// and then use its for implementing auth throttle
// also - create readme.md file in this folder with full spec, flow and documentation of auth throttle



export interface ThrottleRow {
  attempts: number;
  /** Stamped from a per-instance counter when the row is created: a decayed or evicted key starts a new run. */
  readonly run: number;
  /** The key's `free`; Infinity for bookkeeping rows. Decides the eviction tier. */
  readonly free: number;
  lastMs: number;
  /** 0 when the key does not delay. */
  nextMs: number;
}

/** One flow's rows, in last-attempt order (`count` re-inserts the row it touches). */
export interface ThrottleTable {
  readonly rows: Map<string, ThrottleRow>;
  cursor: Iterator<[string, ThrottleRow]> | undefined;
  /** While full, refuse without a scan until this time. */
  fullUntilMs: number;
  fullReported: boolean;
}

export interface MemoryThrottleOptions {
  /** Overrides `authn.throttle.maxRows`. */
  readonly maxRows?: number;
}

type Verdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Gate {
  readonly id: string;
  readonly p: BackoffParams;
}

// More than the rows one attempt can add, so each sweep pass reaches the end.

//TODO: move contsts into config !
const SWEEP_BATCH = 8;
const FULL_RETRY_SECONDS = 60;
const HOLD_OFF_MS = 1000;


const refused = (waitMs: number): Verdict => ({ allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) });

/**
 * Backoff per key, never a lock (A05, A06, H31), for a single app instance. `attempt` checks every gating key and
 * claims the slot with no `await` in between, so parallel attempts are atomic. Rows are keyed by an HMAC of
 * `flow|kind|value` under a random per-instance secret (D7).
 *
 * Capacity: each flow has its own table of at most `maxRows` rows (schema default 1,000,000; a fresh login attempt adds 3),
 * so traffic in one flow never evicts another flow's rows. Each attempt sweeps a few expired rows. When a table is
 * full, rows that delay nobody at that moment are evicted, oldest last attempt first: first expired rows and rows
 * below their key's `free`, then rows deeper in backoff, which loses their count between two slots. A row that is
 * delaying is never evicted; when no row can go, attempts that need a new row are refused. Internet-facing or
 * multi-instance apps use `DbAuthnThrottle`.
 */
@Singleton()
@Injectable(AuthnThrottle)
export class MemoryAuthnThrottle extends AuthnThrottle implements PeekableThrottle {
  @Config('authn.throttle')
  protected Throttle: ThrottleConfig;

  // TODO: instead of throtle flow - each of throtle should be registered in DI container for specific flows
  protected readonly tables: Readonly<Record<ThrottleFlow, ThrottleTable>>;
  protected sweepBatch = SWEEP_BATCH;
  private readonly secret = randomBytes(32);
  private seq = 0;
  private loaded: { readonly params: ThrottleParams; readonly maxRows: number | undefined } | undefined;

  /** DI passes nothing and the limits come from `authn.throttle`; tests pass complete, trusted params. */
  constructor(private readonly explicit?: ThrottleParams, private readonly options: MemoryThrottleOptions = {}) {
    super();
    if (explicit) checkThrottleParams(explicit);
    if (options.maxRows !== undefined) checkThrottleMaxRows(options.maxRows);

    // TODO: it should be resolved via DI continer !
    const table = (): ThrottleTable => ({ rows: new Map(), cursor: undefined, fullUntilMs: 0, fullReported: false });
    this.tables = Object.freeze({ login: table(), mfa: table(), reset: table(), reauth: table() });
  }

  public get params(): ThrottleParams {
    return this.explicit ?? this.configured.params;
  }

  public get maxRows(): number {
    return this.options.maxRows ?? (this.explicit ? undefined : this.configured.maxRows) ?? DEFAULT_THROTTLE_MAX_ROWS;
  }

  // Read once: the tables and their eviction assume fixed limits. The copy is frozen: Configuration hands out live objects.
  private get configured(): { readonly params: ThrottleParams; readonly maxRows: number | undefined } {
    if (!this.loaded) {
      if (!this.Throttle) throw new InvalidOperation('authn.throttle is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');
      const { service: _service, maxRows, ...params } = structuredClone(this.Throttle);
      checkThrottleParams(params);
      if (maxRows !== undefined) checkThrottleMaxRows(maxRows);
      this.loaded = { params: deepFreeze(params), maxRows };
    }
    return this.loaded;
  }

  public async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<Verdict> {
    const nowMs = ctx?.now instanceof Date ? ctx.now.getTime() : NaN;
    if (!Number.isFinite(nowMs)) throw new InvalidArgument('MemoryAuthnThrottle.attempt: ctx.now must be a valid Date');
    const f = this.flow(flow);
    const table = this.tables[flow];
    const gates: Gate[] = [];
    const books: string[] = [];
    const seen = new Set<string>();
    for (const k of keys) {
      const p = this.gateParams(f, k.kind);
      const bookkeeping = k.kind === 'account-ip' && f.ip !== undefined;
      if (!p && !bookkeeping) continue;
      const id = this.keyId(flow, k);
      if (seen.has(id)) continue;
      seen.add(id);
      if (p) gates.push({ id, p });
      else books.push(id);
    }

    for (const fl of THROTTLE_FLOWS) this.sweepSome(this.tables[fl], nowMs, fl === flow ? this.sweepBatch : Math.ceil(this.sweepBatch / 4));

    const waitMs = this.waitMs(table, gates, nowMs);
    if (waitMs > 0) return refused(waitMs);

    let needed = 0;
    for (const id of seen) if (!this.live(table, id, nowMs)) needed++;
    if (needed > 0 && table.rows.size + needed > this.maxRows) {
      const retryAfterSeconds = this.makeRoom(table, flow, needed, nowMs);
      if (retryAfterSeconds !== undefined) return { allowed: false, retryAfterSeconds };
    }

    for (const g of gates) this.count(table, g.id, nowMs, g.p);
    for (const id of books) this.count(table, id, nowMs);
    return { allowed: true };
  }

  /** Refuses as `attempt` would for a delay, counting nothing; a full table refuses only `attempt`. */
  public async peek(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<Verdict> {
    const nowMs = ctx?.now instanceof Date ? ctx.now.getTime() : NaN;
    if (!Number.isFinite(nowMs)) throw new InvalidArgument('MemoryAuthnThrottle.peek: ctx.now must be a valid Date');
    const f = this.flow(flow);
    const gates: Gate[] = [];
    for (const k of keys) {
      const p = this.gateParams(f, k.kind);
      if (p) gates.push({ id: this.keyId(flow, k), p });
    }
    const waitMs = this.waitMs(this.tables[flow], gates, nowMs);
    return waitMs > 0 ? refused(waitMs) : { allowed: true };
  }

  public async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<void> {
    const f = this.flow(flow);
    if (flow === 'reset') return;
    const { rows } = this.tables[flow];
    this.tables[flow].fullUntilMs = 0;
    const spent: ThrottleRow[] = [];
    for (const k of keys) {
      if (k.kind !== 'account-ip') continue;
      const id = this.keyId(flow, k);
      const row = rows.get(id);
      if (row) spent.push(row);
      rows.delete(id);
    }
    for (const k of keys) {
      if (k.kind === 'account') {
        rows.delete(this.keyId(flow, k));
      } else if (k.kind === 'ip' && f.ip) {
        const id = this.keyId(flow, k);
        const row = rows.get(id);
        if (!row) continue;
        // An account-ip run that began before this ip run has attempts the ip row never counted. Several account-ip
        // rows of one success counted the same attempts, so the largest is taken, never the sum (D8).
        const taken = spent.reduce((n, a) => (a.run > row.run ? Math.max(n, a.attempts) : n), 0);
        row.attempts = Math.max(0, row.attempts - taken);
        if (row.attempts === 0) {
          rows.delete(id);
        } else {
          const d = this.delayMs(f.ip, row.attempts);
          row.nextMs = d > 0 ? row.lastMs + d : 0;
        }
      }
    }
  }

  protected delayMs(p: BackoffParams, n: number): number {
    return backoffDelayMs(p, n);
  }

  protected keyId(flow: ThrottleFlow, k: ThrottleKey): string {
    if (typeof k.value !== 'string') throw new InvalidArgument(`MemoryAuthnThrottle: the value of a ${JSON.stringify(String(k.kind))} key must be a string`);
    return createHmac('sha256', this.secret).update(`${flow}|${k.kind}|${k.value}`).digest('base64url');
  }

  /** Once per full episode of a flow's table, again on the next scan when it throws; names no key. */
  protected reportFull(flow: ThrottleFlow): void {
    DI.resolve(Log, ['authn-throttle'], true).warn(`MemoryAuthnThrottle: all ${this.maxRows} ${flow} rows delay someone; ${flow} attempts that need a new row are refused until one frees (authn.throttle.maxRows)`);
  }

  private flow(flow: ThrottleFlow): ThrottleFlowParams {
    if (!THROTTLE_FLOWS.includes(flow)) throw new InvalidArgument(`MemoryAuthnThrottle: unknown flow ${JSON.stringify(String(flow))}`);
    return this.params[flow];
  }

  private gateParams(f: ThrottleFlowParams, kind: ThrottleKey['kind']): BackoffParams | undefined {
    if (kind === 'account') return f.account;
    if (kind === 'ip') return f.ip;
    if (kind === 'global') return this.params.global ?? undefined;
    return undefined;
  }

  private waitMs(table: ThrottleTable, gates: readonly Gate[], nowMs: number): number {
    let waitMs = 0;
    for (const g of gates) {
      const row = this.live(table, g.id, nowMs);
      if (row && row.nextMs > nowMs) waitMs = Math.max(waitMs, row.nextMs - nowMs);
    }
    return waitMs;
  }

  // Idle alone does not expire a row: a delay longer than resetAfterSeconds still runs to its end.
  private stale(row: ThrottleRow, nowMs: number): boolean {
    return nowMs - row.lastMs >= this.params.resetAfterSeconds * 1000 && row.nextMs <= nowMs;
  }

  private live(table: ThrottleTable, id: string, nowMs: number): ThrottleRow | undefined {
    const row = table.rows.get(id);
    if (row && this.stale(row, nowMs)) {
      table.rows.delete(id);
      return undefined;
    }
    return row;
  }

  private count(table: ThrottleTable, id: string, nowMs: number, p?: BackoffParams): void {
    const row = this.live(table, id, nowMs) ?? { attempts: 0, run: ++this.seq, free: p ? p.free : Infinity, lastMs: nowMs, nextMs: 0 };
    row.attempts += 1;
    row.lastMs = Math.max(row.lastMs, nowMs);
    if (p) {
      const d = this.delayMs(p, row.attempts);
      row.nextMs = d > 0 ? nowMs + d : 0;
    }
    table.rows.delete(id);
    table.rows.set(id, row);
  }

  // A Map iterator survives deletes and appends, so each call resumes the pass where the last one stopped.
  private sweepSome(table: ThrottleTable, nowMs: number, batch: number): void {
    for (let i = 0; i < batch; i++) {
      table.cursor ??= table.rows.entries();
      const next = table.cursor.next();
      if (next.done) {
        table.cursor = undefined;
        return;
      }
      const [id, row] = next.value;
      if (this.stale(row, nowMs)) table.rows.delete(id);
    }
  }

  /** Frees room for `needed` new rows in a full table; returns a Retry-After when it cannot. */
  private makeRoom(table: ThrottleTable, flow: ThrottleFlow, needed: number, nowMs: number): number | undefined {
    if (nowMs < table.fullUntilMs) return Math.ceil((table.fullUntilMs - nowMs) / 1000);
    // Slack, so a full table is not scanned on every attempt.
    const target = this.maxRows - Math.max(needed, Math.ceil(this.maxRows / 100));
    this.evict(table, nowMs, target, (r) => r.attempts < r.free || this.stale(r, nowMs));
    const firstFree = this.evict(table, nowMs, target, () => true);
    if (table.rows.size + needed <= this.maxRows) {
      table.fullReported = false;
      // Short of the slack, nearly every row delays: hold off the next scan briefly.
      if (table.rows.size > target) table.fullUntilMs = Math.min(firstFree, nowMs + HOLD_OFF_MS);
      return undefined;
    }
    table.fullUntilMs = Number.isFinite(firstFree) ? firstFree : nowMs + FULL_RETRY_SECONDS * 1000;
    if (!table.fullReported) {
      try {
        this.reportFull(flow);
        table.fullReported = true;
      } catch {
        // No root Log (one registered only in a child): under a flood the refusal matters more than the warning.
      }
    }
    return Math.max(1, Math.ceil((table.fullUntilMs - nowMs) / 1000));
  }

  /** Deletes rows that delay nobody and match `tier`, oldest first, down to `target`; returns the earliest end of a delay seen. */
  private evict(table: ThrottleTable, nowMs: number, target: number, tier: (r: ThrottleRow) => boolean): number {
    let firstFree = Infinity;
    for (const [id, row] of table.rows) {
      if (table.rows.size <= target) break;
      if (row.nextMs > nowMs) firstFree = Math.min(firstFree, row.nextMs);
      else if (tier(row)) table.rows.delete(id);
    }
    return firstFree;
  }
}
