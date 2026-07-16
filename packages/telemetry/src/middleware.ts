import * as express from 'express';
import { DI, Injectable } from '@spinajs/di';
import { Logger, Log, Perf } from '@spinajs/log';
import { ServerMiddleware, Request as sRequest } from '@spinajs/http';

import { Counter, Gauge, Histogram } from 'prom-client';
import { Metrics, MetricMap } from './metrics.js';
import { RequestStats } from './requestStats.js';
import { Timeline } from './timeline.js';
import { PromMetricSink } from './PromMetricSink.js';

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
 * against the DI-resolved {@link Metrics} registry, plus a lifetime
 * {@link RequestStats} and a rolling {@link Timeline} for the JSON stats
 * endpoint. All telemetry work is guarded so it can never break a request.
 */
@Injectable(ServerMiddleware)
export class TelemetryMiddleware extends ServerMiddleware {
  @Logger('telemetry')
  protected Log!: Log;

  /**
   * Metric-name prefix. Overridable by subclasses.
   */
  protected Prefix = DEFAULT_PREFIX;

  protected metrics!: Metrics;
  protected requestsTotal!: Counter<string>;
  protected requestDuration!: Histogram<string>;
  protected inFlight!: Gauge<string>;

  private defined = false;

  /**
   * Lifetime request stats ( status classes, error rate, apdex ).
   */
  public readonly RequestStats = new RequestStats();

  /**
   * Rolling 60 x 1-min timeline of request stats.
   */
  public readonly Timeline = new Timeline();

  constructor() {
    super();
    // Needs req.storage ( ReqStorage = -2 ) and sits alongside RequestId /
    // AccessLog ( Order 2 ).
    this.Order = 2;
  }

  public async resolve(): Promise<void> {
    await super.resolve();
    // Ensure the prom PerfSink exists so the Perf facade discovers it.
    DI.resolve(PromMetricSink);
    Perf.refreshSinks();
  }

  /**
   * Lazily resolve {@link Metrics} and define the metric set on first use.
   * Idempotent — {@link Metrics.defineMetrics} removes+recreates duplicates.
   */
  protected ensureMetrics(): void {
    if (this.defined) return;

    this.metrics = DI.get(Metrics) ?? DI.resolve(Metrics);

    const map: MetricMap = this.metrics.defineMetrics(this.Prefix, [
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
        buckets: DURATION_BUCKETS_MS,
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

  public before(): (req: sRequest, res: express.Response, next: express.NextFunction) => void {
    return (req: sRequest, _res: express.Response, next: express.NextFunction) => {
      try {
        this.ensureMetrics();
        (req.storage as any)[START_KEY] = process.hrtime.bigint();
        this.inFlight.inc();
      } catch (err) {
        this.Log?.warn(err as Error, 'telemetry before() failed');
      }
      next();
    };
  }

  public after(): (req: sRequest, res: express.Response, next: express.NextFunction) => void {
    return (req: sRequest, res: express.Response, next: express.NextFunction) => {
      try {
        this.ensureMetrics();

        const start = (req.storage as any)?.[START_KEY] as bigint | undefined;
        const durationMs = start !== undefined ? Number(process.hrtime.bigint() - start) / 1e6 : 0;

        const method = req.method ?? 'GET';
        const route = this.routeLabel(req);
        const status = res.statusCode;
        const labels = { method, route, status: String(status) };

        this.requestDuration.observe(labels, durationMs);
        this.requestsTotal.inc(labels);
        this.inFlight.dec();

        this.RequestStats.countRequest();
        this.RequestStats.countResponse(status, durationMs);
        this.Timeline.record(status, durationMs, Date.now());
      } catch (err) {
        this.Log?.warn(err as Error, 'telemetry after() failed');
      }
      next();
    };
  }
}
