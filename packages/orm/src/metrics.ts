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

export const ORM_METRIC_POOL_SIZE = 'orm_pool_size';
export const ORM_METRIC_POOL_IN_USE = 'orm_pool_in_use';
export const ORM_METRIC_POOL_WAITING = 'orm_pool_waiting';
export const ORM_METRIC_ACQUIRE_SECONDS = 'orm_pool_acquire_seconds';
export const ORM_METRIC_CONNECTION_STATE = 'orm_connection_state';

/**
 * Sink the ORM publishes pool telemetry to.
 *
 * `@spinajs/orm` deliberately does NOT depend on `@spinajs/metrics`: that package depends on
 * `@spinajs/http`, and putting the HTTP stack underneath the ORM inverts the dependency graph.
 * The ORM owns this abstraction; `@spinajs/metrics` provides the prom-client implementation
 * (`PromOrmMetricsSink`) and an application registers it.
 */
export abstract class OrmMetricsSink {
  /**
   * Records the current value of a gauge.
   *
   * @param name - metric name, one of the ORM_METRIC_* constants
   * @param help - human-readable description, used the first time the metric is created
   * @param labels - label set, always includes `connection`
   * @param value - the value to record
   */
  public abstract gauge(name: string, help: string, labels: Record<string, string>, value: number): void;

  /**
   * Records one observation into a histogram.
   *
   * @param name - metric name, one of the ORM_METRIC_* constants
   * @param help - human-readable description, used the first time the metric is created
   * @param labels - label set, always includes `connection`
   * @param seconds - the observed duration in SECONDS ( prometheus convention )
   */
  public abstract observe(name: string, help: string, labels: Record<string, string>, seconds: number): void;
}

/**
 * Default sink. Discards everything, so an app that wants no telemetry pays nothing.
 */
export class NullOrmMetricsSink extends OrmMetricsSink {
  public gauge(_name: string, _help: string, _labels: Record<string, string>, _value: number): void {
    // intentionally empty
  }

  public observe(_name: string, _help: string, _labels: Record<string, string>, _seconds: number): void {
    // intentionally empty
  }
}
