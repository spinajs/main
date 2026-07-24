import { Injectable, Singleton } from '@spinajs/di';
import * as client from 'prom-client';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Kind of a prom-client metric.
 */
export type MetricType = 'counter' | 'gauge' | 'histogram';

/**
 * Declarative description of a single prom-client metric.
 */
export interface MetricDef {
  name: string;
  help: string;
  type: MetricType;
  labelNames?: string[];

  /**
   * Histogram bucket boundaries. Only meaningful for `type: 'histogram'`.
   */
  buckets?: number[];
}

/**
 * Any concrete prom-client metric produced by {@link Metrics.defineMetrics}.
 */
export type AnyMetric = Counter<string> | Gauge<string> | Histogram<string>;

/**
 * Typed map of metric name -> constructed prom-client metric.
 */
export type MetricMap<T extends AnyMetric = AnyMetric> = Record<string, T>;

/**
 * Thin `@Singleton()` wrapper over a private prom-client {@link Registry}.
 *
 * Deliberately does NOT use prom-client's global default registry so that
 * repeated init in tests ( and multiple SpinaJS apps in one process ) stay
 * isolated. Provides a declarative factory for building metric sets and an
 * async Prometheus text renderer.
 */
@Singleton()
@Injectable()
export class Metrics {
  protected registry: Registry;

  constructor() {
    this.registry = new client.Registry();
  }

  /**
   * The private registry backing this service.
   */
  public getRegistry(): Registry {
    return this.registry;
  }

  /**
   * Build ( or rebuild ) a set of metrics from declarative definitions and
   * register them against this service's registry.
   *
   * Each metric name is prefixed with `${prefix}_`. If a metric with the same
   * name is already registered ( e.g. on a re-init during tests ) it is removed
   * and recreated rather than throwing, mirroring swagger-stats'
   * `clearPrometheusMetrics` behaviour.
   *
   * @param prefix - metric-name prefix ( e.g. `http` -> `http_requests_total` )
   * @param defs - the metrics to construct
   * @returns a map keyed by the ( unprefixed ) definition name
   */
  public defineMetrics(prefix: string, defs: MetricDef[]): MetricMap {
    const map: MetricMap = {};

    for (const def of defs) {
      const name = `${prefix}_${def.name}`;

      // Guard against duplicate registration ( re-init in tests ).
      if (this.registry.getSingleMetric(name)) {
        this.registry.removeSingleMetric(name);
      }

      const common = {
        name,
        help: def.help,
        labelNames: def.labelNames ?? [],
        registers: [this.registry],
      };

      let metric: AnyMetric;
      switch (def.type) {
        case 'counter':
          metric = new client.Counter(common);
          break;
        case 'gauge':
          metric = new client.Gauge(common);
          break;
        case 'histogram':
          metric = new client.Histogram({
            ...common,
            buckets: def.buckets ?? client.linearBuckets(1, 1, 10),
          });
          break;
        default:
          throw new Error(`unknown metric type '${String(def.type)}' for metric '${name}'`);
      }

      map[def.name] = metric;
    }

    return map;
  }

  /**
   * Register the default process/heap/cpu/event-loop metrics against this
   * ( non-global ) registry.
   */
  public collectDefault(): void {
    client.collectDefaultMetrics({ register: this.registry });
  }

  /**
   * Render the registry as Prometheus exposition text.
   *
   * prom-client 14's `Registry.metrics()` is ASYNC — this awaits it.
   */
  public async render(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * The Prometheus exposition `Content-Type` for the `/metrics` response.
   */
  public contentType(): string {
    return this.registry.contentType;
  }
}
