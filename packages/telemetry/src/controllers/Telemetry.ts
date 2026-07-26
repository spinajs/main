import { BasePath, BaseController, Get, Policy, Query, Ok } from '@spinajs/http';
import { Autoinject } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { BadRequest } from '@spinajs/exceptions';

import { TelemetryStore } from './../store.js';
import { InMemoryPerfSink } from './../InMemoryPerfSink.js';
import { HealthCheckRunner } from './../health.js';
import { ServiceUnavailable } from './../responses.js';

// Importing the DTO barrel runs the @Schema decorators, which is what makes the
// response schemas resolvable by name in the generated OpenAPI document.
import './../dto/index.js';

// Same reason, for security rather than documentation: importing the policy
// modules runs their @Injectable decorators, which is what puts the classes in
// the DI container under the names the routes below name as STRINGS ( via
// `telemetry.auth.policies.*` ). Nothing else forces them to load — this
// controller is mounted by the config-declared directory scan, and that
// configuration is auto-discovered from node_modules, so an app never has to
// import the package barrel. And http FAILS OPEN on an unresolvable policy name
// ( it logs `No policy named ...`, drops it, and a route left with no policies
// calls next() ), which would serve these endpoints unauthenticated.
import './../policies/TelemetryTokenPolicy.js';
import './../policies/PublicPolicy.js';

/**
 * JSON telemetry API. Machine-facing — consumed by dashboards, uptime monitors
 * and orchestrator probes.
 *
 * The prometheus scrape endpoint deliberately lives on its own controller at
 * the bare `/metrics` path, not under this prefix.
 */
@BasePath('telemetry')
export class TelemetryController extends BaseController {
  @Autoinject(TelemetryStore)
  protected Store: TelemetryStore;

  @Autoinject(InMemoryPerfSink)
  protected PerfSink: InMemoryPerfSink;

  @Autoinject(HealthCheckRunner)
  protected Health: HealthCheckRunner;

  @Config('telemetry.health.version')
  protected Version: string;

  /**
   * Lifetime request statistics plus the rolling timeline.
   *
   * @returns {StatsResponse} Lifetime stats and the per-bucket timeline
   * @response 403 Access token missing or invalid
   */
  @Get('stats')
  @Policy('telemetry.auth.policies.stats')
  public async getStats() {
    const stats = this.Store.RequestStats;

    // Rates are not maintained on the hot path — they are derived here, over the
    // whole collection window, or `req_rate` / `err_rate` would always read 0.
    stats.updateRates(Date.now() - this.Store.StartedAt);

    return new Ok({
      all: stats.toJSON(),
      timeline: this.Store.Timeline.toJSON(),
    });
  }

  /**
   * The rolling timeline alone, with each bucket annotated with the wall-clock
   * window it covers so consumers do not have to reverse the bucket key.
   *
   * @param buckets - how many of the most recent buckets to return; all of them when omitted
   * @returns {TimelineResponse} The annotated timeline
   * @response 400 `buckets` was not a positive integer
   * @response 403 Access token missing or invalid
   */
  @Get('timeline')
  @Policy('telemetry.auth.policies.timeline')
  public async getTimeline(@Query() buckets?: string) {
    const timeline = this.Store.Timeline;
    const snapshot = timeline.toJSON();

    let keys = Object.keys(snapshot)
      .map((k) => Number(k))
      .sort((a, b) => a - b);

    // Only a genuinely ABSENT `buckets` means "all of them". An explicitly empty
    // `?buckets=` is a supplied value that is not a positive integer, so it is
    // rejected like every other invalid one rather than silently meaning "all".
    if (buckets !== undefined && buckets !== null) {
      // Taken as a string and parsed here rather than declared `number` and left
      // to the decorator's schema: a query value arrives as a string, and how the
      // framework coerces a non-numeric one ( `Number( 'abc' )` -> NaN, rejected
      // by the arg validator with a generic message ) is not something this
      // endpoint's contract should depend on.
      //
      // `Number( '' )` is 0, not NaN, so the empty string falls through to the
      // `count < 1` rejection below on its own.
      const count = Number(buckets);

      if (!Number.isInteger(count) || count < 1) {
        throw new BadRequest('buckets must be a positive integer');
      }

      // The most recent N — the tail of an ascending key order.
      keys = keys.slice(-count);
    }

    return new Ok({
      bucketMs: timeline.bucketMs,
      length: timeline.length,
      buckets: keys.map((key) => ({
        key,
        from: key * timeline.bucketMs,
        to: (key + 1) * timeline.bucketMs,
        stats: snapshot[String(key)],
      })),
    });
  }

  /**
   * Per method+route request breakdown.
   *
   * No percentiles — query them from prometheus against the `route`-labelled
   * `http_request_duration_ms` histogram, which carries the same label values.
   *
   * @returns {RoutesResponse} Per-route request statistics
   * @response 403 Access token missing or invalid
   */
  @Get('routes')
  @Policy('telemetry.auth.policies.routes')
  public async getRoutes() {
    return new Ok(this.Store.RouteStats.toJSON());
  }

  /**
   * Aggregated performance measurements collected through the `Perf` facade —
   * every `Perf.measure`, `@Measure`, `Perf.count` and `Perf.value` in the
   * process, including the ORM's `orm.query` spans.
   *
   * @returns {PerfResponse} Aggregated spans and events
   * @response 403 Access token missing or invalid
   */
  @Get('perf')
  @Policy('telemetry.auth.policies.perf')
  public async getPerf() {
    return new Ok(this.PerfSink.toJSON());
  }

  /**
   * Liveness. Runs no checks, so it can never be made slow or flaky by a
   * dependency — if this answers, the process is alive.
   *
   * @returns {HealthResponse} Process liveness information
   */
  @Get('health')
  @Policy('telemetry.auth.policies.health')
  public async getHealth() {
    const uptimeMs = Math.round(process.uptime() * 1000);

    return new Ok({
      status: 'up',
      startedAt: Date.now() - uptimeMs,
      uptimeMs,
      pid: process.pid,
      node: process.version,

      // omitted rather than reported as null when `telemetry.health.version` is unset
      ...(this.Version ? { version: this.Version } : {}),
    });
  }

  /**
   * Readiness. Runs every registered `HealthCheck`, each raced against
   * `telemetry.health.timeoutMs`.
   *
   * @returns {ReadyResponse} Overall readiness and the per-check results
   * @response 503 At least one check is down ( or degraded, when `telemetry.health.failOnDegraded` is set )
   */
  @Get('ready')
  @Policy('telemetry.auth.policies.ready')
  public async getReady() {
    const report = await this.Health.run();

    if (this.Health.isFailing(report.status)) {
      return new ServiceUnavailable(report);
    }

    return new Ok(report);
  }
}
