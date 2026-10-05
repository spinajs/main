import { BasePath, BaseController, Get } from '@spinajs/http';
import { Autoinject } from '@spinajs/di';

import { Metrics } from './../metrics.js';
import { PrometheusResponse } from './../responses.js';

// A slot naming a policy class (`PublicPolicy` for the probes, the deprecated
// `TelemetryTokenPolicy`) needs that class registered, and only an import does
// it: the directory scan mounts this controller without the package barrel. An
// unregistered name fails the route's registration.
import './../policies/TelemetryTokenPolicy.js';
import './../policies/PublicPolicy.js';
import { TelemetryAccess } from './../policies/TelemetryAccessPolicy.js';

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
   * @response 401 No valid credentials (by default the telemetry token in x-metrics-token or Authorization: Bearer)
   * @response 403 The caller lacks the permission telemetry.auth.permissions names for this endpoint
   */
  @Get('/')
  @TelemetryAccess('metrics')
  public async getMetrics() {
    return new PrometheusResponse(this.MetricsService);
  }
}
