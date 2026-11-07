import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Logger, Log } from '@spinajs/log';
import { DEFAULT_IPV6_PREFIX, throttleIp } from '@spinajs/util';

import { ServerMiddleware } from '../interfaces.js';
import type { IMiddlewareContext, Response } from '../interfaces.js';
import { quietRateLimitAnswer, rateLimitAnswer } from './rate-limit-answer.js';

/**
 * One throttling rule. Matched against the incoming request path by PREFIX, on a
 * segment boundary - `/auth` covers `/auth`, `/auth/login`, `/auth/password/reset-request`
 * and so on, but not `/authority`.
 * Rules are checked in configuration order and the FIRST match wins, so put
 * the most specific paths first.
 */
export interface IThrottleRule {
  /**
   * Path prefix matched against `req.path`. Note: `http.controllers.route.prefix`
   * is part of the path a client requests, so include it here if the app sets one.
   */
  path: string;

  /** HTTP methods the rule applies to ( eg. ['POST'] ); missing means every method */
  methods?: string[];

  /** Requests allowed per window, per client ip */
  limit: number;

  /** Fixed window length in seconds */
  windowSeconds: number;

  /**
   * false: no `X-RateLimit-*` headers on the requests the rule counts; the 429 still carries `Retry-After`. For routes
   * whose answers must not reveal a limiter (authn). Default true.
   */
  headers?: boolean;
}

/**
 * A single counter state: how many hits landed in the current window and when
 * the window resets ( epoch milliseconds ).
 */
export interface IThrottleHit {
  count: number;
  resetAt: number;
}

/**
 * Counter storage seam. The default {@link MemoryThrottleStore} keeps counters
 * in process memory - correct for a single instance, per-instance ( so
 * effectively `limit * instances` ) behind a load balancer. Register an own
 * implementation ( eg. redis backed ) as `ThrottleStore` to share counters
 * across instances.
 */
export abstract class ThrottleStore {
  public abstract increment(key: string, windowSeconds: number): IThrottleHit | Promise<IThrottleHit>;
}

/**
 * In-memory fixed-window counters. Expired entries are dropped lazily on hit
 * and swept periodically so long-idle keys do not accumulate forever.
 */
@Injectable(ThrottleStore)
export class MemoryThrottleStore extends ThrottleStore {
  protected Hits = new Map<string, IThrottleHit>();
  protected SweepCounter = 0;

  /** Every how many increments a full sweep of expired entries runs */
  public static readonly SWEEP_INTERVAL = 10_000;

  public increment(key: string, windowSeconds: number): IThrottleHit {
    const now = Date.now();

    if (++this.SweepCounter >= MemoryThrottleStore.SWEEP_INTERVAL) {
      this.SweepCounter = 0;
      for (const [k, hit] of this.Hits) {
        if (hit.resetAt <= now) {
          this.Hits.delete(k);
        }
      }
    }

    let hit = this.Hits.get(key);
    if (!hit || hit.resetAt <= now) {
      hit = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.Hits.set(key, hit);
    }

    hit.count++;
    return hit;
  }
}

// Express matches routes case-insensitively, so a rule must too, or `/AUTH/login` reaches the route unthrottled.
const underPath = (path: string, prefix: string): boolean => {
  const p = path.toLowerCase();
  const r = prefix.toLowerCase().replace(/\/+$/, '');
  return p === r || p.startsWith(`${r}/`);
};

/**
 * Per-ip, per-route rate limiting. Complements ( does NOT replace ) the
 * authn throttle, the real per-account and per-IP login limiter - this one caps
 * request volume from one address before any handler runs. The address is
 * `req.storage.realIp` ( `http.trustProxy` only ), else the socket address.
 *
 * Config:
 *   http.throttle.enabled   (boolean, default false)
 *   http.throttle.rules     (IThrottleRule[]; first prefix match wins)
 *   http.throttle.ipv6Prefix (16..128, default 64; an IPv6 client is counted per prefix of this many bits, IPv4 whole)
 *
 * Example - protect the unauthenticated rbac auth surface:
 *   throttle: {
 *     enabled: true,
 *     rules: [
 *       { path: '/auth/password', methods: ['POST'], limit: 5, windowSeconds: 300 },
 *       { path: '/auth', methods: ['POST'], limit: 10, windowSeconds: 60 },
 *     ],
 *   }
 *
 * A limited request answers 429 with `Retry-After` and the standard
 * `X-RateLimit-*` headers, through the reply pipeline; the counters live in {@link ThrottleStore}.
 */
@Injectable(ServerMiddleware)
export class ThrottleMiddleware extends ServerMiddleware {
  @Config('http.throttle')
  protected Throttle: { enabled?: boolean; rules?: IThrottleRule[]; ipv6Prefix?: number } | undefined;

  @Autoinject(ThrottleStore)
  protected Store!: ThrottleStore;

  @Logger('http')
  protected Log!: Log;

  private compiled?: { readonly rules: readonly IThrottleRule[]; readonly prefix: number } | null;

  constructor() {
    super();
    // after RealIp (1) so `req.storage.realIp` is set, before controllers
    this.Order = 3;
  }

  public async resolve(): Promise<void> {
    this.throttle();
    await super.resolve();
  }

  /** Off unless `http.throttle.enabled`, and with no rules. */
  public isEnabled(): boolean {
    return this.throttle() !== null;
  }

  /** Synchronous for a request no rule covers. */
  public onBefore(ctx: IMiddlewareContext): Promise<Response | void> | undefined {
    const throttle = this.throttle();
    const rule = throttle?.rules.find((r) => underPath(ctx.req.path, r.path) && (!r.methods || r.methods.some((m) => m.toUpperCase() === ctx.req.method)));
    return throttle && rule ? this.count(ctx, rule, throttle.prefix) : undefined;
  }

  private async count({ req, res, storage }: IMiddlewareContext, rule: IThrottleRule, prefix: number): Promise<Response | void> {
    // Never req.ip: under express's own `trust proxy` it would come from a client-set X-Forwarded-For (SR-03).
    const ip = storage?.realIp ?? req.socket?.remoteAddress ?? 'unknown';
    const key = `${throttleIp(ip, prefix)}:${rule.path}:${rule.methods?.join(',') ?? '*'}`;

    // A store failure rejects: without a working counter the limit cannot be enforced, so the global error answer
    // answers the request instead of the route (fail closed).
    const hit = await this.Store.increment(key, rule.windowSeconds);
    return rule.headers === false ? quietRateLimitAnswer(rule.limit, hit) : rateLimitAnswer(res, rule.limit, hit);
  }

  private throttle(): { readonly rules: readonly IThrottleRule[]; readonly prefix: number } | null {
    if (this.compiled !== undefined) {
      return this.compiled;
    }

    const cfg = this.Throttle;
    if (!cfg?.enabled) {
      return (this.compiled = null);
    }

    const rules = cfg.rules ?? [];
    // A rule set past the schema without a usable limit or window never throttles and shadows the rules after it.
    rules.forEach((r, i) => {
      if (!(Number.isFinite(r.limit) && r.limit >= 0)) throw new InvalidOption(`http.throttle.rules.${i}.limit must be a finite number >= 0`);
      if (!(Number.isFinite(r.windowSeconds) && r.windowSeconds > 0)) throw new InvalidOption(`http.throttle.rules.${i}.windowSeconds must be a finite positive number`);
      if (r.headers !== undefined && typeof r.headers !== 'boolean') throw new InvalidOption(`http.throttle.rules.${i}.headers must be a boolean`);
    });

    const prefix = cfg.ipv6Prefix ?? DEFAULT_IPV6_PREFIX;
    if (!(Number.isInteger(prefix) && prefix >= 16 && prefix <= 128)) throw new InvalidOption('http.throttle.ipv6Prefix must be an integer from 16 to 128');

    if (rules.length === 0) {
      this.Log.warn('http.throttle is enabled but has no rules - throttling is a no-op. Check http.throttle.rules.');
      return (this.compiled = null);
    }
    return (this.compiled = { rules, prefix });
  }
}
