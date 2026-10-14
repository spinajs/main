import { createHmac, randomBytes } from 'node:crypto';

import { DI, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { Log } from '@spinajs/log-common';
import { deepFreeze } from '@spinajs/util';
import type { KeyedBackoffGate, KeyedBackoffOptions, KeyedBackoffRow, KeyedBackoffVerdict } from '@spinajs/util';

import { AuthnThrottle } from '../contracts/throttle.js';
import type { ThrottleFlow, ThrottleKey } from '../contracts/throttle.js';
import type { AuthnContext } from '../contracts/credentials.js';
import { THROTTLE_FLOWS, backoffDelayMs } from '../contracts/throttle.js';
import type { BackoffParams, ThrottleFlowParams, ThrottleParams } from '../contracts/throttle.js';
import { checkThrottleMaxRows, checkThrottleParams } from '../service/boot/env.js';
import { FlowLimiter } from './flow-limiter.js';
import { DEFAULT_MEMORY_THROTTLE, DEFAULT_THROTTLE_MAX_ROWS } from './params.js';
import type { MemoryThrottleConfig, ThrottleConfig } from './params.js';
import type { PeekableThrottle } from './peek.js';

export interface MemoryThrottleOptions {
  /** Overrides `authn.throttle.maxRows`. */
  readonly maxRows?: number;
}

interface Loaded {
  readonly params: ThrottleParams;
  readonly maxRows: number | undefined;
  readonly memory: MemoryThrottleConfig;
}

/**
 * Backoff per key, never a lock (A05, A06, H31), for a single app instance. `attempt` checks every gating key and
 * claims the slot with no `await` in between, so parallel attempts are atomic. Rows are keyed by an HMAC of
 * `flow|kind|value` under a random per-instance secret (D7).
 *
 * Capacity: each flow has its own `FlowLimiter` of at most `maxRows` rows (schema default 1,000,000; a fresh login
 * attempt adds 3), so traffic in one flow never evicts another flow's rows. Each attempt sweeps a few expired rows.
 * When a table is full, rows that delay nobody at that moment are evicted, oldest last attempt first: first expired
 * rows and rows below their key's `free`, then rows deeper in backoff, which loses their count between two slots. A
 * row that is delaying is never evicted; when no row can go, attempts that need a new row are refused.
 * Internet-facing or multi-instance apps use `DbAuthnThrottle`.
 */
@Singleton()
@Injectable(AuthnThrottle)
export class MemoryAuthnThrottle extends AuthnThrottle implements PeekableThrottle {
  @Config('authn.throttle')
  protected Throttle: ThrottleConfig;

  private readonly limiters = new Map<ThrottleFlow, FlowLimiter>();
  private readonly secret = randomBytes(32);
  private loaded: Loaded | undefined;

  /** DI passes nothing and the limits come from `authn.throttle`; tests pass complete, trusted params. */
  constructor(private readonly explicit?: ThrottleParams, private readonly options: MemoryThrottleOptions = {}) {
    super();
    if (explicit) checkThrottleParams(explicit);
    if (options.maxRows !== undefined) checkThrottleMaxRows(options.maxRows);
  }

  public get params(): ThrottleParams {
    return this.explicit ?? this.configured.params;
  }

  public get maxRows(): number {
    return this.options.maxRows ?? (this.explicit ? undefined : this.configured.maxRows) ?? DEFAULT_THROTTLE_MAX_ROWS;
  }

  private get memory(): MemoryThrottleConfig {
    return this.explicit ? DEFAULT_MEMORY_THROTTLE : this.configured.memory;
  }

  // Read once: the limiters and their eviction assume fixed limits. The copy is frozen: Configuration hands out live objects.
  private get configured(): Loaded {
    if (!this.loaded) {
      if (!this.Throttle) throw new InvalidOperation('authn.throttle is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');
      const { service: _service, maxRows, memory, ...params } = structuredClone(this.Throttle);
      checkThrottleParams(params);
      if (maxRows !== undefined) checkThrottleMaxRows(maxRows);
      this.loaded = { params: deepFreeze(params), maxRows, memory: deepFreeze({ ...DEFAULT_MEMORY_THROTTLE, ...memory }) };
    }
    return this.loaded;
  }

  public async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<KeyedBackoffVerdict> {
    const nowMs = ctx?.now instanceof Date ? ctx.now.getTime() : NaN;
    if (!Number.isFinite(nowMs)) throw new InvalidArgument('MemoryAuthnThrottle.attempt: ctx.now must be a valid Date');
    const f = this.flow(flow);
    const gates: KeyedBackoffGate[] = [];
    const counted: string[] = [];
    for (const k of keys) {
      const backoff = this.gateParams(f, k.kind);
      if (backoff) gates.push({ key: this.keyId(flow, k), backoff });
      else if (k.kind === 'account-ip' && f.ip !== undefined) counted.push(this.keyId(flow, k));
    }

    const limiter = this.limiter(flow);
    // The limiter's own attempt sweeps its full batch.
    const batch = Math.ceil(this.memory.sweepBatch / 4);
    for (const [fl, other] of this.limiters) if (fl !== flow) other.sweep(nowMs, batch);
    return limiter.attempt(gates, counted, nowMs);
  }

  /** Refuses as `attempt` would for a delay, counting nothing; a full table refuses only `attempt`. */
  public async peek(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<KeyedBackoffVerdict> {
    const nowMs = ctx?.now instanceof Date ? ctx.now.getTime() : NaN;
    if (!Number.isFinite(nowMs)) throw new InvalidArgument('MemoryAuthnThrottle.peek: ctx.now must be a valid Date');
    const f = this.flow(flow);
    const gates: KeyedBackoffGate[] = [];
    for (const k of keys) {
      const backoff = this.gateParams(f, k.kind);
      if (backoff) gates.push({ key: this.keyId(flow, k), backoff });
    }
    return this.limiter(flow).peek(gates, nowMs);
  }

  public async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<void> {
    const f = this.flow(flow);
    if (flow === 'reset') return;
    const limiter = this.limiter(flow);
    limiter.release();
    const spent: KeyedBackoffRow[] = [];
    for (const k of keys) {
      if (k.kind !== 'account-ip') continue;
      const id = this.keyId(flow, k);
      const row = limiter.row(id);
      if (row) spent.push(row);
      limiter.delete(id);
    }
    for (const k of keys) {
      if (k.kind === 'account') {
        limiter.delete(this.keyId(flow, k));
      } else if (k.kind === 'ip' && f.ip) {
        const id = this.keyId(flow, k);
        const row = limiter.row(id);
        if (!row) continue;
        // An account-ip run that began before this ip run has attempts the ip row never counted. Several account-ip
        // rows of one success counted the same attempts, so the largest is taken, never the sum (D8).
        const taken = spent.reduce((n, a) => (a.run > row.run ? Math.max(n, a.attempts) : n), 0);
        row.attempts = Math.max(0, row.attempts - taken);
        if (row.attempts === 0) {
          limiter.delete(id);
        } else {
          const d = this.delayMs(f.ip, row.attempts);
          row.nextMs = d > 0 ? row.lastMs + d : 0;
        }
      }
    }
  }

  /** The flow's limiter. The first use of any flow resolves all four from the root container: the throttle is a root singleton. */
  protected limiter(flow: ThrottleFlow): FlowLimiter {
    if (this.limiters.size === 0) this.resolveLimiters();
    return this.limiters.get(flow)!;
  }

  // All at once, so a FlowLimiter that DI shares between flows fails the first attempt, not the first one of another flow.
  private resolveLimiters(): void {
    const memory = this.memory;
    const resolved = new Map<ThrottleFlow, FlowLimiter>();
    for (const flow of THROTTLE_FLOWS) {
      const options: KeyedBackoffOptions = {
        maxRows: this.maxRows,
        resetAfterMs: this.params.resetAfterSeconds * 1000,
        sweepBatch: memory.sweepBatch,
        fullRetryMs: memory.fullRetrySeconds * 1000,
        holdOffMs: memory.holdOffMs,
        delay: (p, n) => this.delayMs(p, n),
        onFull: () => this.reportFull(flow),
      };
      const limiter: unknown = DI.resolve(FlowLimiter, [flow, options]);
      if (!(limiter instanceof FlowLimiter)) {
        const what = (limiter as object | null | undefined)?.constructor?.name ?? String(limiter);
        throw new InvalidOperation(`MemoryAuthnThrottle: DI resolved the ${flow} limiter as ${what}, not a FlowLimiter; a FlowLimiter must resolve synchronously, so it cannot depend on an AsyncService`);
      }
      const name = limiter.constructor.name;
      if ([...resolved.values()].includes(limiter)) {
        throw new InvalidOperation(`MemoryAuthnThrottle: DI resolved one ${name} for the ${limiter.flow} and ${flow} flows; declare @NewInstance() on ${name}: any DI decorator on a FlowLimiter subclass, such as @Autoinject, replaces the inherited one`);
      }
      if (limiter.flow !== flow) {
        throw new InvalidOperation(`MemoryAuthnThrottle: DI resolved a ${name} of the ${limiter.flow} flow for the ${flow} flow; ${name} must pass its flow argument to FlowLimiter`);
      }
      resolved.set(flow, limiter);
    }
    for (const [flow, limiter] of resolved) this.limiters.set(flow, limiter);
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
}
