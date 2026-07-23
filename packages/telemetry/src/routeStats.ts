import { IRequestStatsSnapshot, RequestStats } from './requestStats.js';

/**
 * One row of the per-route breakdown.
 */
export interface IRouteStatsEntry {
  method: string;
  route: string;
  stats: IRequestStatsSnapshot;
}

/**
 * Serializable snapshot of {@link RouteStats}.
 */
export interface IRouteStatsSnapshot {
  /** True once the entry cap was hit and new routes stopped being tracked. */
  truncated: boolean;
  routes: IRouteStatsEntry[];
}

const KEY_SEPARATOR = ' ';

/**
 * A bounded `method + route -> RequestStats` map.
 *
 * The bound is not optional. The telemetry middleware falls back to the raw
 * request path when no route matched, so an unbounded map would grow one entry
 * per distinct URL a 404-scanning bot tries.
 */
export class RouteStats {
  private entries = new Map<string, RequestStats>();
  private truncated = false;

  constructor(public readonly maxEntries: number, public readonly apdexThreshold: number) {}

  /**
   * True once at least one route was dropped because the cap was reached.
   */
  public get Truncated(): boolean {
    return this.truncated;
  }

  /**
   * Record one completed response. A new method+route key is only created while
   * under `maxEntries`; past that, known routes keep accumulating and unknown
   * ones are dropped.
   */
  public record(method: string, route: string, statusCode: number, durationMs: number): void {
    const key = `${method}${KEY_SEPARATOR}${route}`;

    let stats = this.entries.get(key);
    if (!stats) {
      if (this.entries.size >= this.maxEntries) {
        this.truncated = true;
        return;
      }
      stats = new RequestStats(this.apdexThreshold);
      this.entries.set(key, stats);
    }

    stats.countRequest();
    stats.countResponse(statusCode, durationMs);
  }

  public toJSON(): IRouteStatsSnapshot {
    const routes: IRouteStatsEntry[] = [];

    for (const [key, stats] of this.entries) {
      const separator = key.indexOf(KEY_SEPARATOR);
      routes.push({
        method: key.substring(0, separator),
        route: key.substring(separator + 1),
        stats: stats.toJSON(),
      });
    }

    return { truncated: this.truncated, routes };
  }
}
