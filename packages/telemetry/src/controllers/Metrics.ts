import { BasePath, BaseController, Get, Policy } from '@spinajs/http';
import { Autoinject } from '@spinajs/di';

import { Metrics } from './../metrics.js';
import { PrometheusResponse } from './../responses.js';

/**
 * Prometheus scrape endpoint.
 *
 * Deliberately kept at the bare `/metrics` path rather than under the
 * `/telemetry` prefix used by the JSON api — this is the path existing
 * `scrape_configs` already point at.
 */
@BasePath('metrics')
export class MetricsController extends BaseController {
  @Autoinject(Metrics)
  protected MetricsService: Metrics;

  /**
   * Prometheus exposition text for every metric on the registry: the `http_*`
   * request metrics, the `perf_*` bridge metrics, any application metrics
   * declared through `Metrics.defineMetrics`, and — when
   * `telemetry.collectDefaultMetrics` is on — the `process_*` / `nodejs_*` set.
   *
   * @response 200 {string} Prometheus exposition text ( text/plain )
   * @response 403 Access token missing or invalid
   */
  @Get('/')
  @Policy('telemetry.auth.policies.metrics')
  public async getMetrics() {
    return new PrometheusResponse(this.MetricsService);
  }
}
