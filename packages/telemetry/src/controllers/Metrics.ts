import { BasePath, BaseController, Get, Policy } from '@spinajs/http';
import { Autoinject } from '@spinajs/di';

import { Metrics } from './../metrics.js';
import { PrometheusResponse } from './../responses.js';

// Importing the policy modules runs their @Injectable decorators, which is what
// puts the classes in the DI container under the names the routes below name as
// STRINGS ( via `telemetry.auth.policies.*` ). Nothing else forces them to load:
// this controller is mounted by the config-declared directory scan, and that
// configuration is auto-discovered from node_modules — so an app never has to
// import the package barrel. And http FAILS OPEN on an unresolvable policy name
// ( it logs `No policy named ...`, drops it, and a route left with no policies
// calls next() ), which would serve /metrics unauthenticated.
import './../policies/TelemetryTokenPolicy.js';
import './../policies/PublicPolicy.js';

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
