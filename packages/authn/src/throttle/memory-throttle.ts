import { createHmac, randomBytes } from 'node:crypto';

import { DI, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log } from '@spinajs/log-common';
import { MemoryThrottleStore, deepFreeze } from '@spinajs/util';
import type { KeyedBackoffOptions, ThrottleStore } from '@spinajs/util';

import { AuthnThrottle, THROTTLE_FLOWS, backoffDelayMs } from '../contracts/throttle.js';
import type { BackoffParams, ThrottleFlow, ThrottleKey, ThrottleParams } from '../contracts/throttle.js';
import { checkThrottleMaxRows, checkThrottleParams } from '../service/boot/env.js';
import { FlowLimiter } from './flow-limiter.js';
import { DEFAULT_MEMORY_THROTTLE, DEFAULT_THROTTLE_MAX_ROWS } from './params.js';
import type { MemoryThrottleConfig, ThrottleConfig } from './params.js';
import { StoreAuthnThrottle } from './store-throttle.js';

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
 * attempt adds 3, 4 with `global`), so traffic in one flow never evicts another flow's rows. Each attempt sweeps a
 * few expired rows. When a table is full, rows that delay nobody at that moment are evicted, oldest last attempt first: first expired
 * rows and rows below their key's `free`, then rows deeper in backoff, which loses their count between two slots. A
 * row that is delaying is never evicted; when no row can go, attempts that need a new row are refused.
 * Internet-facing or multi-instance apps use `DbAuthnThrottle`.
 */
@Singleton()
@Injectable(AuthnThrottle)
export class MemoryAuthnThrottle extends StoreAuthnThrottle {
  @Config('authn.throttle')
  protected Throttle: ThrottleConfig;

  private memoryStore: MemoryThrottleStore | undefined;
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

  protected async store(): Promise<ThrottleStore> {
    return this.tables;
  }

  /** The flow's limiter. The first use of any flow resolves all four from the root container: the throttle is a root singleton. */
  protected limiter(flow: ThrottleFlow): FlowLimiter {
    return this.tables.limiter(flow) as FlowLimiter;
  }

  private get tables(): MemoryThrottleStore {
    if (!this.memoryStore) {
      const memory = this.memory;
      this.memoryStore = new MemoryThrottleStore({
        flows: THROTTLE_FLOWS,
        maxRows: this.maxRows,
        resetAfterMs: this.params.resetAfterSeconds * 1000,
        sweepBatch: memory.sweepBatch,
        fullRetryMs: memory.fullRetrySeconds * 1000,
        holdOffMs: memory.holdOffMs,
        delay: (p, n) => this.delayMs(p, n),
        onFull: (flow) => this.reportFull(flow as ThrottleFlow),
        limiter: this.resolveLimiter(),
      });
    }
    return this.memoryStore;
  }

  // The store checks the limiters too; these checks come first, so the error says what to fix in the DI setup.
  private resolveLimiter(): (flow: string, options: KeyedBackoffOptions) => FlowLimiter {
    const resolved = new Map<string, FlowLimiter>();
    return (flow, options) => {
      // The store asks once per flow and builds again after a failed build.
      if (resolved.has(flow)) resolved.clear();
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
      return limiter;
    };
  }

  protected delayMs(p: BackoffParams, n: number): number {
    return backoffDelayMs(p, n);
  }

  protected keyId(flow: ThrottleFlow, k: ThrottleKey): string {
    return createHmac('sha256', this.secret).update(`${flow}|${k.kind}|${k.value}`).digest('base64url');
  }

  /** Once per full episode of a flow's table, again on the next scan when it throws; names no key. */
  protected reportFull(flow: ThrottleFlow): void {
    DI.resolve(Log, ['authn-throttle'], true).warn(`MemoryAuthnThrottle: all ${this.maxRows} ${flow} rows delay someone; ${flow} attempts that need a new row are refused until one frees (authn.throttle.maxRows)`);
  }
}
