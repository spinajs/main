import { DI } from '@spinajs/di';
import { Metrics, MetricDef, MetricMap, Gauge, Histogram } from '@spinajs/telemetry-common';

/**
 * Point-in-time view of a driver's connection pool.
 */
export interface IPoolMetrics {
  /** Connections currently open ( idle + in use ). */
  Size: number;

  /** Connections currently checked out by a query. */
  InUse: number;

  /** Callers waiting for a free connection. */
  Waiting: number;
}

/**
 * Prefix `Metrics.defineMetrics` puts in front of every name below.
 */
export const ORM_METRIC_PREFIX = 'orm';

/** Key of a metric inside the {@link MetricMap} — the name WITHOUT the `orm_` prefix. */
export const ORM_METRIC_KEY_POOL_SIZE = 'pool_size';
export const ORM_METRIC_KEY_POOL_IN_USE = 'pool_in_use';
export const ORM_METRIC_KEY_POOL_WAITING = 'pool_waiting';
export const ORM_METRIC_KEY_ACQUIRE_SECONDS = 'pool_acquire_seconds';
export const ORM_METRIC_KEY_CONNECTION_STATE = 'connection_state';

/** Fully qualified metric names, as they appear in the Prometheus exposition text. */
export const ORM_METRIC_POOL_SIZE = `${ORM_METRIC_PREFIX}_${ORM_METRIC_KEY_POOL_SIZE}`;
export const ORM_METRIC_POOL_IN_USE = `${ORM_METRIC_PREFIX}_${ORM_METRIC_KEY_POOL_IN_USE}`;
export const ORM_METRIC_POOL_WAITING = `${ORM_METRIC_PREFIX}_${ORM_METRIC_KEY_POOL_WAITING}`;
export const ORM_METRIC_ACQUIRE_SECONDS = `${ORM_METRIC_PREFIX}_${ORM_METRIC_KEY_ACQUIRE_SECONDS}`;
export const ORM_METRIC_CONNECTION_STATE = `${ORM_METRIC_PREFIX}_${ORM_METRIC_KEY_CONNECTION_STATE}`;

/**
 * Acquiring a pooled connection is normally sub-millisecond and only becomes interesting once the
 * pool saturates, so the buckets are dense at the bottom and reach far enough to show a caller
 * that queued for seconds. prom-client's linear default ( 1..10 SECONDS ) would put every healthy
 * acquire in the first bucket and tell us nothing.
 */
export const ORM_ACQUIRE_BUCKETS_SECONDS = [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const ORM_METRIC_DEFS: MetricDef[] = [
  { name: ORM_METRIC_KEY_POOL_SIZE, help: 'Open ORM pool connections', type: 'gauge', labelNames: ['connection'] },
  { name: ORM_METRIC_KEY_POOL_IN_USE, help: 'ORM pool connections checked out by a query', type: 'gauge', labelNames: ['connection'] },
  { name: ORM_METRIC_KEY_POOL_WAITING, help: 'Callers waiting for a free ORM pool connection', type: 'gauge', labelNames: ['connection'] },
  { name: ORM_METRIC_KEY_CONNECTION_STATE, help: 'ORM connection state: 1 connected, 0 otherwise', type: 'gauge', labelNames: ['connection'] },
  { name: ORM_METRIC_KEY_ACQUIRE_SECONDS, help: 'Seconds spent acquiring an ORM pool connection', type: 'histogram', labelNames: ['connection'], buckets: ORM_ACQUIRE_BUCKETS_SECONDS },
];

/**
 * `defineMetrics` REBUILDS the metric objects on every call — a second call would silently reset
 * every value — so each `Metrics` service gets its metric set built exactly once. Keyed by the
 * service instance rather than a module-level flag so that `DI.clearCache()` ( tests, or a second
 * SpinaJS app in one process ) starts from a fresh registry without leaking metrics across it.
 */
const DEFINED = new WeakMap<Metrics, MetricMap>();

/**
 * The ORM's metric set, built against the shared `Metrics` service from
 * `@spinajs/telemetry-common`.
 *
 * The ORM deliberately depends on `-common` and NOT on `@spinajs/telemetry`: that package pulls in
 * `@spinajs/http`, `@spinajs/log`, `@spinajs/validation` and `@spinajs/configuration`, and putting
 * the HTTP stack underneath every database connection inverts the dependency graph. `-common`
 * needs nothing but `@spinajs/di` and prom-client. `@spinajs/telemetry` re-exports it, so the
 * `/metrics` endpoint renders the very registry these metrics land in — no wiring needed.
 *
 * Returns null rather than throwing when the service cannot be resolved: publishing a metric must
 * never be able to fail a query or a health probe.
 */
export function ormMetrics(): MetricMap | null {
  try {
    const service = DI.get(Metrics) ?? DI.resolve(Metrics);
    let map = DEFINED.get(service);

    if (!map) {
      map = service.defineMetrics(ORM_METRIC_PREFIX, ORM_METRIC_DEFS);
      DEFINED.set(service, map);
    }

    return map;
  } catch {
    return null;
  }
}

/** Narrowing helpers: `defineMetrics` is typed by its declarations, not by the values it returns. */
export function ormGauge(map: MetricMap, key: string): Gauge<string> {
  // eslint-disable-next-line security/detect-object-injection
  return map[key] as Gauge<string>;
}

export function ormHistogram(map: MetricMap, key: string): Histogram<string> {
  // eslint-disable-next-line security/detect-object-injection
  return map[key] as Histogram<string>;
}
