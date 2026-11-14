import { Autoinject, DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';
import { ServerMiddleware } from '@spinajs/http';
import type { IFinishContext, IMiddlewareContext } from '@spinajs/http';

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
 * `onBefore` starts the clock and the in-flight gauge; `onFinish` balances the
 * gauge and, unless the client aborted, records the request ( {@link record} ).
 * Every bit of it is guarded so telemetry can never break a request.
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
    // Alongside RequestId / AccessLog.
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
   * A stable, low-cardinality route label: the mounted path of the matched route, else the raw request path.
   */
  protected routeLabel({ req, path }: IMiddlewareContext): string {
    // `http:<METHOD> <mounted path>`
    if (typeof path === 'string' && path.length > 0) return path.slice(path.indexOf(' ') + 1);
    const matched: unknown = (req as { route?: { path?: unknown } }).route?.path;
    if (typeof matched === 'string' && matched.length > 0) return matched;
    return req.path ?? req.originalUrl ?? 'unknown';
  }

  public onBefore({ storage }: IMiddlewareContext): void {
    try {
      this.ensureMetrics();
      this.inFlight.inc();
      // Only once the gauge went up: onFinish balances a request it finds started.
      (storage as unknown as Record<string, unknown>)[START_KEY] = process.hrtime.bigint();
    } catch (err) {
      this.Log?.warn(err as Error, 'telemetry onBefore failed');
    }
  }

  /**
   * Balances the in-flight gauge of a request `onBefore` started, then records it unless the client aborted: an
   * aborted request's `res.statusCode` is the un-sent default.
   */
  public onFinish(ctx: IFinishContext): void {
    if (typeof startOf(ctx) !== 'bigint') return;

    try {
      this.inFlight.dec();
    } catch (err) {
      this.Log?.warn(err as Error, 'telemetry in-flight gauge failed');
    }
    if (ctx.aborted) return;

    try {
      this.record(ctx);
    } catch (err) {
      this.Log?.warn(err as Error, 'telemetry finish handler failed');
    }
  }

  /** The metrics and the store entry of one finished request. */
  protected record(ctx: IFinishContext): void {
    try {
      const durationMs = Number(process.hrtime.bigint() - (startOf(ctx) as bigint)) / 1e6;
      const method = ctx.req.method ?? 'GET';
      const route = this.routeLabel(ctx);
      const status = ctx.res.statusCode;
      const labels = { method, route, status: String(status) };

      this.requestDuration.observe(labels, durationMs);
      this.requestsTotal.inc(labels);

      this.Store.record(method, route, status, durationMs);
    } catch (err) {
      this.Log?.warn(err as Error, 'telemetry finish handler failed');
    }
  }
}

function startOf({ storage }: IMiddlewareContext): unknown {
  return (storage as unknown as Record<string, unknown> | undefined)?.[START_KEY];
}
