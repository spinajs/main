import { Metrics } from './metrics.js';
import { TelemetryMiddleware } from './middleware.js';

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
 * from the given telemetry middleware's lifetime stats.
 */
export function statsHandler(mw: TelemetryMiddleware): (req: MinimalRequest, res: IMinimalResponse) => void {
  return (_req: MinimalRequest, res: IMinimalResponse): void => {
    const body = JSON.stringify({
      all: mw.RequestStats.toJSON(),
      timeline: mw.Timeline.toJSON(),
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(body);
  };
}
