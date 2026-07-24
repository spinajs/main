import { Metrics } from './metrics.js';
import { TelemetryStore } from './store.js';

/**
 * Minimal request/response shapes the endpoint handlers rely on. Kept
 * intentionally structural ( `setHeader` / `end` ) so the handlers are not
 * coupled to express beyond what a plain Node `ServerResponse` provides.
 */
export interface IMinimalResponse {
  setHeader(name: string, value: string): void;
  statusCode?: number;
  end(body?: string): void;
}

export type MinimalRequest = unknown;

/**
 * Build the Prometheus `/metrics` scrape handler.
 *
 * Sets `Content-Type` from the registry and writes the ( async-rendered )
 * exposition text.
 */
export function metricsHandler(metrics: Metrics): (req: MinimalRequest, res: IMinimalResponse) => Promise<void> {
  return async (_req: MinimalRequest, res: IMinimalResponse): Promise<void> => {
    const body = await metrics.render();
    res.setHeader('Content-Type', metrics.contentType());
    res.end(body);
  };
}

/**
 * Build the JSON stats handler.
 *
 * Writes `{ all: RequestStats.toJSON(), timeline: Timeline.toJSON() }` read
 * from the shared telemetry store — the same counters `GET /telemetry/stats`
 * serves. The rate fields differ though: only the controller endpoint calls
 * `RequestStats.updateRates( ... )`, and because that MUTATES the shared
 * `RequestStats`, the `req_rate` / `err_rate` this handler emits are whatever
 * the last `/telemetry/stats` call left behind ( `0` if nobody has called it ).
 */
export function statsHandler(store: TelemetryStore): (req: MinimalRequest, res: IMinimalResponse) => void {
  return (_req: MinimalRequest, res: IMinimalResponse): void => {
    const body = JSON.stringify({
      all: store.RequestStats.toJSON(),
      timeline: store.Timeline.toJSON(),
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(body);
  };
}
