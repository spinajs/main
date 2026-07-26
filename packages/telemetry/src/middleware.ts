import * as express from 'express';
import { Autoinject, DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';
import { ServerMiddleware, Request as sRequest } from '@spinajs/http';

import { Counter, Gauge, Histogram } from 'prom-client';
import { Metrics, MetricMap } from './metrics.js';
import { TelemetryStore } from './store.js';

/**
 * Default metric-name prefix for the HTTP telemetry metrics.
 */
export const DEFAULT_PREFIX = 'http';

/**
 * Histogram bucket boundaries ( ms ) for request duration.
 */
export const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/**
 * Storage key under `req.storage` holding the per-request start time.
 */
const START_KEY = '__telemetryStart';

/**
 * HTTP request-timing / metrics middleware.
 *
 * Times every request and records:
 *  - `${prefix}_requests_total{method,route,status}` — a Counter,
 *  - `${prefix}_request_duration_ms{method,route,status}` — a Histogram,
 *  - `${prefix}_requests_in_flight` — a Gauge,
 * against the DI-resolved {@link Metrics} registry, and feeds the shared
 * {@link TelemetryStore} that backs the JSON stats endpoints.
 *
 * All of the end-of-request work runs from a `res.on( 'finish' )` handler
 * registered in `before()` — `ServerMiddleware.after()` is never reached for a
 * normal matched route, the same reason http's own `AccessLog` / `PerfRollup`
 * middlewares work this way. A `res.on( 'close' )` handler balances the in-flight
 * gauge — and only the gauge — for requests the client aborted, where `'finish'`
 * never fires. Every bit of it is guarded so telemetry can never break a request.
 */
@Injectable(ServerMiddleware)
export class TelemetryMiddleware extends ServerMiddleware {
  @Logger('telemetry')
  protected Log!: Log;

  /**
   * The shared aggregates. This middleware is the only writer.
   */
  @Autoinject(TelemetryStore)
  protected Store!: TelemetryStore;

  /**
   * Metric-name prefix. Set it with the `telemetry.prefix` configuration key —
   * that is the supported way to re-prefix, and it needs no subclass.
   *
   * The precedence implemented in {@link ensureMetrics} is: a value assigned to
   * this field that differs from {@link DEFAULT_PREFIX} wins, otherwise
   * `telemetry.prefix` is used, otherwise {@link DEFAULT_PREFIX}. That override
   * exists for subclasses that are replacing the middleware wholesale — see the
   * README's "Replacing the middleware" section, which also covers the
   * double-registration hazard of subclassing. Do NOT subclass merely to change
   * the prefix.
   */
  protected Prefix = DEFAULT_PREFIX;

  @Config('telemetry.prefix', { defaultValue: DEFAULT_PREFIX })
  protected ConfiguredPrefix!: string;

  @Config('telemetry.buckets', { defaultValue: DURATION_BUCKETS_MS })
  protected Buckets!: number[];

  protected metrics!: Metrics;
  protected requestsTotal!: Counter<string>;
  protected requestDuration!: Histogram<string>;
  protected inFlight!: Gauge<string>;

  private defined = false;

  constructor() {
    super();
    // Needs req.storage ( ReqStorage = -2 ) and sits alongside RequestId /
    // AccessLog ( Order 2 ).
    this.Order = 2;
  }

  /**
   * Lazily resolve {@link Metrics} and define the metric set on first use.
   * Idempotent — {@link Metrics.defineMetrics} removes+recreates duplicates.
   */
  protected ensureMetrics(): void {
    if (this.defined) return;

    this.metrics = DI.get(Metrics) ?? DI.resolve(Metrics);

    // A subclass that overrode Prefix keeps it; otherwise configuration wins.
    const prefix = this.Prefix !== DEFAULT_PREFIX ? this.Prefix : this.ConfiguredPrefix ?? DEFAULT_PREFIX;

    const map: MetricMap = this.metrics.defineMetrics(prefix, [
      {
        name: 'requests_total',
        help: 'Total number of HTTP requests',
        type: 'counter',
        labelNames: ['method', 'route', 'status'],
      },
      {
        name: 'request_duration_ms',
        help: 'HTTP request duration in milliseconds',
        type: 'histogram',
        labelNames: ['method', 'route', 'status'],
        buckets: this.Buckets ?? DURATION_BUCKETS_MS,
      },
      {
        name: 'requests_in_flight',
        help: 'Number of HTTP requests currently in flight',
        type: 'gauge',
      },
    ]);

    this.requestsTotal = map['requests_total'] as Counter<string>;
    this.requestDuration = map['request_duration_ms'] as Histogram<string>;
    this.inFlight = map['requests_in_flight'] as Gauge<string>;
    this.defined = true;
  }

  /**
   * Derive a stable, low-cardinality route label. Prefers the matched route
   * path ( `req.route.path` or `req.storage.route` ) over the raw request path.
   */
  protected routeLabel(req: sRequest): string {
    const anyReq = req as any;
    const matched = anyReq.route?.path ?? (req.storage as any)?.route;
    if (typeof matched === 'string' && matched.length > 0) return matched;
    return req.path ?? anyReq.originalUrl ?? 'unknown';
  }

  /**
   * Do the end-of-request accounting. Called from the response `finish` event,
   * never from `after()`.
   */
  protected onFinish(req: sRequest, res: express.Response): void {
    try {
      const start = (req.storage as any)?.[START_KEY] as bigint | undefined;
      const durationMs = start !== undefined ? Number(process.hrtime.bigint() - start) / 1e6 : 0;

      const method = req.method ?? 'GET';

      // Read the route label HERE, not in before(): `req.route` is only
      // populated once the router has matched.
      const route = this.routeLabel(req);
      const status = res.statusCode;
      const labels = { method, route, status: String(status) };

      // Balance before()'s inc() FIRST: a throw from anything below would
      // otherwise strand the gauge one higher for the rest of the process.
      this.inFlight.dec();

      this.requestDuration.observe(labels, durationMs);
      this.requestsTotal.inc(labels);

      this.Store.record(method, route, status, durationMs);
    } catch (err) {
      this.Log?.warn(err as Error, 'telemetry finish handler failed');
    }
  }

  public before(): (req: sRequest, res: express.Response, next: express.NextFunction) => void {
    return (req: sRequest, res: express.Response, next: express.NextFunction) => {
      try {
        this.ensureMetrics();
        (req.storage as any)[START_KEY] = process.hrtime.bigint();
        this.inFlight.inc();

        // The inc() above must be balanced exactly once, whichever event wins.
        // 'finish' does NOT fire when the client disconnects mid-response, only
        // 'close' does — without the 'close' arm the gauge drifts monotonically
        // upward for the life of the process behind a load balancer with client
        // timeouts. On a normal request both fire, 'finish' first, so the flag
        // is what keeps the gauge from being decremented twice.
        let settled = false;

        res.on('finish', () => {
          if (settled) return;
          settled = true;
          this.onFinish(req, res);
        });

        res.on('close', () => {
          if (settled) return;
          settled = true;

          // Aborted request: balance the gauge and NOTHING else. `res.statusCode`
          // is still the un-sent default here, so recording it would pollute the
          // status-class counters and the route stats with a response that was
          // never sent.
          try {
            this.inFlight.dec();
          } catch (err) {
            this.Log?.warn(err as Error, 'telemetry close handler failed');
          }
        });
      } catch (err) {
        this.Log?.warn(err as Error, 'telemetry before() failed');
      }
      next();
    };
  }

  /**
   * Nothing to do after the controllers — express does not run this for a
   * matched route. See {@link onFinish}.
   */
  public after(): null {
    return null;
  }
}
