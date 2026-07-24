import { AsyncService, DI, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Configuration } from '@spinajs/configuration-common';

import { RequestStats } from './requestStats.js';
import { Timeline } from './timeline.js';
import { RouteStats } from './routeStats.js';

/**
 * The single, process-wide home of the collected http telemetry aggregates.
 *
 * It exists because the writer and the reader are different objects:
 * {@link TelemetryMiddleware} is an `@Injectable( ServerMiddleware )` and is
 * therefore NOT a singleton — the instance express mounts is not the instance a
 * controller gets from `@Autoinject`. Keeping the aggregates on the middleware
 * meant the JSON endpoints read an object nothing ever wrote to. The middleware
 * now only writes ( {@link record} ), the controller only reads, and both talk
 * to this one `@Singleton()`.
 */
@Singleton()
@Injectable()
export class TelemetryStore extends AsyncService {
  @Config('telemetry.apdexThresholdMs', { defaultValue: 25 })
  protected ApdexThresholdMs!: number;

  @Config('telemetry.timeline.length', { defaultValue: 60 })
  protected TimelineLength!: number;

  @Config('telemetry.timeline.bucketMs', { defaultValue: 60_000 })
  protected TimelineBucketMs!: number;

  @Config('telemetry.routes.maxEntries', { defaultValue: 500 })
  protected RoutesMaxEntries!: number;

  /**
   * Whether per-route stats are recorded. Read on the hot path, so it must stay
   * a plain, DI-independent field ( a directly-instantiated store in a unit test
   * has no resolved Configuration, and a `@Config` getter cannot be assigned ).
   * Populated from `telemetry.routes.enabled` in `resolve()`.
   */
  public RoutesEnabled = true;

  /**
   * Epoch ms at which collection started. Used to compute the lifetime request
   * / error rates.
   */
  public readonly StartedAt = Date.now();

  /**
   * Lifetime request stats ( status classes, error rate, apdex ). Constructed
   * with defaults here and rebuilt in `resolve()` once configuration is
   * available, so a DI-less `new TelemetryStore()` is usable in unit tests.
   */
  public RequestStats = new RequestStats();

  /**
   * Rolling timeline of request stats. Rebuilt in `resolve()`.
   */
  public Timeline = new Timeline();

  /**
   * Per method+route breakdown. Rebuilt in `resolve()`.
   */
  public RouteStats = new RouteStats(500, 25);

  public async resolve(): Promise<void> {
    await super.resolve();

    // Rebuild the aggregates now that configuration is available.
    this.RequestStats = new RequestStats(this.ApdexThresholdMs);
    this.Timeline = new Timeline(this.TimelineLength, this.TimelineBucketMs, this.ApdexThresholdMs);
    this.RouteStats = new RouteStats(this.RoutesMaxEntries, this.ApdexThresholdMs);

    // RoutesEnabled is a hot-path field, not a @Config getter, so read it here.
    const cfg = DI.get(Configuration);
    this.RoutesEnabled = cfg?.get('telemetry.routes.enabled', true) ?? true;
  }

  /**
   * Record one completed response into every aggregate.
   *
   * @param method - http verb
   * @param route - low-cardinality route label ( the matched route path )
   * @param statusCode - response status
   * @param durationMs - how long the request took
   */
  public record(method: string, route: string, statusCode: number, durationMs: number): void {
    this.RequestStats.countRequest();
    this.RequestStats.countResponse(statusCode, durationMs);
    this.Timeline.record(statusCode, durationMs, Date.now());

    if (this.RoutesEnabled !== false) {
      this.RouteStats.record(method, route, statusCode, durationMs);
    }
  }
}
