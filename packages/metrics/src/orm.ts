import { OrmMetricsSink } from '@spinajs/orm';
import * as client from 'prom-client';

/**
 * prom-client implementation of the ORM's metrics seam. Register it once at application start:
 *
 * ```ts
 * DI.register(PromOrmMetricsSink).as(OrmMetricsSink);
 * ```
 *
 * The dependency deliberately runs `@spinajs/metrics` -> `@spinajs/orm` and never the other way:
 * this package depends on `@spinajs/http`, so an ORM that depended on it would drag the whole HTTP
 * stack underneath every database connection. `@spinajs/http` does not depend on `@spinajs/orm`,
 * so the graph stays acyclic.
 *
 * Metrics land on prom-client's default registry, which is the registry this package's `/metrics`
 * controller already exposes, so no extra wiring is needed.
 */
export class PromOrmMetricsSink extends OrmMetricsSink {
  public gauge(name: string, help: string, labels: Record<string, string>, value: number): void {
    const existing = client.register.getSingleMetric(name) as client.Gauge<string> | undefined;
    const metric = existing ?? new client.Gauge({ name, help, labelNames: Object.keys(labels) });

    metric.set(labels, value);
  }

  public observe(name: string, help: string, labels: Record<string, string>, seconds: number): void {
    const existing = client.register.getSingleMetric(name) as client.Histogram<string> | undefined;
    const metric = existing ?? new client.Histogram({ name, help, labelNames: Object.keys(labels) });

    metric.observe(labels, seconds);
  }
}
