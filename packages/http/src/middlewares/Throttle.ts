import * as express from 'express';
import { Autoinject, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

import { ServerMiddleware, Request as sRequest, HTTP_STATUS_CODE } from '../interfaces.js';

/**
 * One throttling rule. Matched against the incoming request path by PREFIX -
 * `/auth` covers `/auth/login`, `/auth/password/reset-request` and so on.
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

/**
 * Per-ip, per-route rate limiting. Complements ( does NOT replace ) the
 * per-account lockout in `@spinajs/rbac` - this one caps request volume from
 * one address before any handler runs, the lockout counts failures against the
 * account no matter where they come from.
 *
 * Config:
 *   http.throttle.enabled   (boolean, default false)
 *   http.throttle.rules     (IThrottleRule[]; first prefix match wins)
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
 * `X-RateLimit-*` headers; the counters live in {@link ThrottleStore}.
 */
@Injectable(ServerMiddleware)
export class ThrottleMiddleware extends ServerMiddleware {
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Autoinject(ThrottleStore)
  protected Store!: ThrottleStore;

  @Logger('http')
  protected Log!: Log;

  constructor() {
    super();
    // after RealIp (1) so `req.storage.realIp` is set, before controllers
    this.Order = 3;
  }

  public before(): ((req: sRequest, res: express.Response, next: express.NextFunction) => void) | null {
    const cfg = this.Configuration.get<{ enabled?: boolean; rules?: IThrottleRule[] }>('http.throttle', undefined);

    if (!cfg?.enabled) {
      return null;
    }

    const rules = (Array.isArray(cfg.rules) ? cfg.rules : []).filter((r) => r && typeof r.path === 'string' && r.limit > 0 && r.windowSeconds > 0);

    if (rules.length === 0) {
      this.Log.warn('http.throttle is enabled but has no valid rules - throttling is a no-op. Check http.throttle.rules.');
      return null;
    }

    return (req: sRequest, res: express.Response, next: express.NextFunction) => {
      const rule = rules.find((r) => req.path.startsWith(r.path) && (!r.methods || r.methods.some((m) => m.toUpperCase() === req.method)));

      if (!rule) {
        return next();
      }

      const ip = (req.storage?.realIp as string) ?? req.ip ?? 'unknown';
      const key = `${ip}:${rule.path}:${rule.methods?.join(',') ?? '*'}`;

      Promise.resolve(this.Store.increment(key, rule.windowSeconds))
        .then((hit) => {
          res.set('X-RateLimit-Limit', String(rule.limit));
          res.set('X-RateLimit-Remaining', String(Math.max(0, rule.limit - hit.count)));
          res.set('X-RateLimit-Reset', String(Math.ceil(hit.resetAt / 1000)));

          if (hit.count > rule.limit) {
            const retryAfter = Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000));
            res.set('Retry-After', String(retryAfter));
            res.status(HTTP_STATUS_CODE.TOO_MANY_REQUESTS).json({
              error: {
                code: 'E_TOO_MANY_REQUESTS',
                message: 'Too many requests, try again later',
              },
            });
            return;
          }

          next();
        })
        // a broken counter store must not take the whole route down - let the
        // request through and let the error handler log the fault
        .catch((err) => next(err));
    };
  }

  public after(): null {
    return null;
  }
}
