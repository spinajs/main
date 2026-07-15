# `@spinajs/telemetry`

Observability for SpinaJS, derived from the swagger-stats design but adapted to
SpinaJS's DI + middleware conventions. It provides:

- **`Metrics`** — a `@Singleton()` wrapper over a private `prom-client` `Registry`
  (isolated from the global default registry) with a declarative metric factory
  (`defineMetrics`), default process metrics (`collectDefault`), and async
  Prometheus text rendering (`render` / `contentType`).
- **`TelemetryMiddleware`** — an `@Injectable(ServerMiddleware)` that times every
  HTTP request and records a duration **histogram**, a request **counter**, and
  an in-flight **gauge** (keyed by `method` / `route` / `status`), plus a
  lifetime `RequestStats` and a rolling `Timeline`. Telemetry errors never break
  the request.
- **`RequestStats`** — pure status-class counters (1xx..5xx), error rate, request
  rate, response-time min/max/avg, and **Apdex**.
- **`Timeline`** — a rolling ring of `RequestStats` buckets (default 60 x 1 min).
- **endpoint handlers** — `metricsHandler(metrics)` (the Prometheus `/metrics`
  scrape endpoint) and `statsHandler(mw)` (a JSON stats snapshot). Both are plain
  `(req, res)` handlers a consumer wires into their own router.

## Usage

```js
import { DI } from '@spinajs/di';
import { Metrics, TelemetryMiddleware, metricsHandler, statsHandler } from '@spinajs/telemetry';

// Prometheus scrape endpoint
const metrics = await DI.resolve(Metrics);
metrics.collectDefault();
router.get('/metrics', metricsHandler(metrics));

// JSON stats snapshot ( from the middleware's lifetime stats + timeline )
const mw = await DI.resolve(TelemetryMiddleware);
router.get('/telemetry/stats', statsHandler(mw));
```

The `TelemetryMiddleware` is registered as a `ServerMiddleware` and picked up by
the HTTP server automatically; it lazily defines its metric set on first request.
