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
- **`PromMetricSink`** — an `@Injectable(PerfSink)` that bridges the
  `@spinajs/log` **`Perf`** facade to Prometheus: every `Perf.measure` /
  `@Measure` / `Perf.count` measurement (including the ORM `orm.query` spans and
  HTTP per-request rollups) is exported as a `perf_*` metric with **no extra
  wiring**.
- **`RequestStats`** — pure status-class counters (1xx..5xx), error rate, request
  rate, response-time min/max/avg, and **Apdex**.
- **`Timeline`** — a rolling ring of `RequestStats` buckets (default 60 x 1 min).
- **endpoint handlers** — `metricsHandler(metrics)` (the Prometheus `/metrics`
  scrape endpoint) and `statsHandler(mw)` (a JSON stats snapshot). Both are plain
  `(req, res)` handlers a consumer wires into their own router.

The registry is **isolated** (not `prom-client`'s global default), so multiple
SpinaJS apps in one process — and repeated init in tests — stay independent.

---

## Quick start

Expose the two endpoints from your own router. `TelemetryMiddleware` is picked up
by the HTTP server automatically (it is a `ServerMiddleware`); it lazily defines
its metric set on the first request.

```ts
import { DI } from '@spinajs/di';
import { Metrics, TelemetryMiddleware, metricsHandler, statsHandler } from '@spinajs/telemetry';

// Prometheus scrape endpoint
const metrics = await DI.resolve(Metrics);
metrics.collectDefault(); // optional: process_* / nodejs_* metrics

router.get('/metrics', metricsHandler(metrics));

// JSON stats snapshot ( from the middleware's lifetime stats + timeline )
const mw = await DI.resolve(TelemetryMiddleware);
router.get('/telemetry/stats', statsHandler(mw));
```

`GET /metrics` returns Prometheus exposition text with the correct
`Content-Type`; `GET /telemetry/stats` returns `{ all, timeline }` (see
[JSON stats](#json-stats-endpoint)).

---

## HTTP request metrics

Once `TelemetryMiddleware` is active, every request is timed (with
`process.hrtime.bigint()`) and recorded against the shared registry:

| Series | Type | Labels |
| --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status` |
| `http_request_duration_ms` | histogram | `method`, `route`, `status` |
| `http_requests_in_flight` | gauge | — |

The `route` label prefers the **matched** route path (`req.route.path`) over the
raw URL, keeping cardinality bounded. The prefix (`http`) and duration buckets
are overridable by subclassing:

```ts
import { Injectable } from '@spinajs/di';
import { ServerMiddleware } from '@spinajs/http';
import { TelemetryMiddleware } from '@spinajs/telemetry';

@Injectable(ServerMiddleware)
export class ApiTelemetry extends TelemetryMiddleware {
  protected Prefix = 'api'; // -> api_requests_total, api_request_duration_ms, ...
}
```

---

## Custom application metrics

Use `Metrics.defineMetrics(prefix, defs)` to declare your own metrics on the same
isolated registry — they show up in the same `/metrics` scrape. It is
**idempotent** (a duplicate name is removed and recreated), so re-defining on a
test re-init won't throw.

```ts
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry';
import type { Counter, Histogram } from 'prom-client';

const metrics = await DI.resolve(Metrics);

const map = metrics.defineMetrics('orders', [
  { name: 'created_total', help: 'Orders created', type: 'counter', labelNames: ['channel'] },
  { name: 'value_eur', help: 'Order value in EUR', type: 'histogram', buckets: [10, 50, 100, 500] },
  { name: 'pending', help: 'Orders awaiting payment', type: 'gauge' },
]);

(map['created_total'] as Counter<string>).inc({ channel: 'web' });
(map['value_eur'] as Histogram<string>).observe(129.9);

// Render on demand ( render() is async in prom-client 14 )
const exposition = await metrics.render();
```

`MetricDef.type` is `'counter' | 'gauge' | 'histogram'`; `labelNames` and
`buckets` (histogram only) are optional. Keep label **values** low-cardinality —
never put ids, emails, or raw URLs in a label.

---

## Performance metrics → Prometheus (the perf dual-sink)

`@spinajs/log` exposes a `Perf` facade for instrumenting arbitrary code
(`Perf.measure` / `Perf.start` / `Perf.count` / `Perf.value` and the `@Measure`
decorator). Each measurement is fanned out to every registered `PerfSink`. This
package ships **`PromMetricSink`**, so **installing `@spinajs/telemetry` alongside
`@spinajs/http` automatically exports all of it to Prometheus** — you don't call
prom-client yourself.

### What gets exported

| Series | Type | Labels | Source |
| --- | --- | --- | --- |
| `perf_span_duration_ms` | histogram | `name` | every `Perf.measure` / `@Measure` / `span.end()` |
| `perf_events_total` | counter | `name` | every `Perf.count` / `Perf.value` |
| `perf_scope_total_ms` | histogram | `name` | per-request rollup totals (e.g. total DB time per request) |

The `name` label is the measurement name (e.g. `orm.query`, `http.request`, or
your own). **It must be low-cardinality** — use a fixed vocabulary of names, not
per-request unique strings.

### Instrument your code — it lands in Prometheus for free

```ts
import { Perf, Measure } from '@spinajs/log';

// wrap a block ( async or sync )
await Perf.measure('report.build', () => buildReport(customerId));
// -> perf_span_duration_ms{name="report.build"}

// count events
Perf.count('cache.miss');
// -> perf_events_total{name="cache.miss"}

// decorate a method
class ReportService {
  @Measure('report.render')
  async render() { /* ... */ }
  // -> perf_span_duration_ms{name="report.render"}
}
```

Out of the box you also get, with zero extra code:

- **`perf_span_duration_ms{name="orm.query"}`** — every SQL query, timed by the
  ORM (`SqlDriver.execute`).
- **`perf_scope_total_ms{name="orm.query"}`** — total DB time *per HTTP request*
  (emitted by the HTTP `PerfRollup` middleware at request end).

Example Prometheus queries:

```promql
# p95 query latency
histogram_quantile(0.95, sum by (le) (rate(perf_span_duration_ms_bucket{name="orm.query"}[5m])))

# average DB time contributed per request
rate(perf_scope_total_ms_sum{name="orm.query"}[5m]) / rate(perf_scope_total_ms_count{name="orm.query"}[5m])
```

### Log thresholds vs. prom export

The default **log** sink (`LogMetricSink` in `@spinajs/log`) only writes a line
when a span exceeds its `logger.perf.thresholds` (slow → `warn`, fast → `trace`).
`PromMetricSink` is independent — it records **every** measurement regardless of
threshold, so your histograms are complete. Tune log noise with `logger.perf.*`
without affecting the metrics.

### Registration timing

`PromMetricSink` is discovered by `Perf` because `TelemetryMiddleware.resolve()`
resolves it (and calls `Perf.refreshSinks()`) when the HTTP server constructs its
middleware. So the bridge is live whenever the telemetry middleware is. If you use
telemetry **without** `@spinajs/http`, resolve the sink yourself once during
bootstrap so `Perf` can find it:

```ts
import { DI } from '@spinajs/di';
import { Perf } from '@spinajs/log';
import { PromMetricSink } from '@spinajs/telemetry';

DI.resolve(PromMetricSink);
Perf.refreshSinks();
```

### Write your own sink

`PerfSink` is a plain registerable abstract class — add another destination
(StatsD, OTLP, a DB) without touching the producers. Register it with
`@Injectable(PerfSink)` and `Perf` fans measurements to it too:

```ts
import { Injectable } from '@spinajs/di';
import { PerfSink, IPerfMetric, IPerfRollup } from '@spinajs/log';

@Injectable(PerfSink)
export class StatsdSink extends PerfSink {
  public collect(m: IPerfMetric): void {
    if (m.kind === 'span') statsd.timing(m.name, m.durationMs ?? 0);
    else statsd.increment(m.name, m.value ?? 1);
  }
  public onScopeEnd(rollup: IPerfRollup): void {
    for (const [name, e] of Object.entries(rollup.byName)) statsd.timing(`${name}.request`, e.totalMs);
  }
}
```

A sink's `collect` / `onScopeEnd` must never throw meaningfully — the `Perf`
facade already guards every call so one bad sink can't break measured code or the
other sinks.

---

## JSON stats endpoint

`statsHandler(mw)` writes `{ all, timeline }` from the middleware's lifetime
`RequestStats` and rolling `Timeline`:

```jsonc
{
  "all": {
    "requests": 1284, "responses": 1284, "errors": 12,
    "info": 0, "success": 1201, "redirect": 60, "client_error": 11, "server_error": 1,
    "total_time": 48210, "max_time": 812, "min_time": 1, "avg_time": 37.5,
    "apdex_satisfied": 1180, "apdex_tolerated": 40, "apdex_score": 0.94,
    "req_rate": 0, "err_rate": 0
  },
  "timeline": {
    "29014823": { "requests": 42, "responses": 42, "avg_time": 33.1, "apdex_score": 0.95 /* ... */ }
  }
}
```

- **`RequestStats`** accumulates status-class counters, response-time
  aggregates, and an **Apdex** score (`(satisfied + tolerated/2) / responses`;
  default satisfied threshold 25 ms, tolerated up to 4×).
- **`Timeline`** keeps a rolling ring of per-bucket `RequestStats` (default
  60 buckets × 60 s), keyed by `floor(timestamp / bucketMs)`.

Both are pure and take the timestamp in, so they're deterministic under test.

---

## Metrics reference

| Series | Type | Labels | Emitted by |
| --- | --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status` | `TelemetryMiddleware` |
| `http_request_duration_ms` | histogram | `method`, `route`, `status` | `TelemetryMiddleware` |
| `http_requests_in_flight` | gauge | — | `TelemetryMiddleware` |
| `perf_span_duration_ms` | histogram | `name` | `PromMetricSink` (from `Perf.measure`/`@Measure`) |
| `perf_events_total` | counter | `name` | `PromMetricSink` (from `Perf.count`/`Perf.value`) |
| `perf_scope_total_ms` | histogram | `name` | `PromMetricSink` (from per-request rollups) |
| `process_*` / `nodejs_*` | various | — | `metrics.collectDefault()` (opt-in) |

Duration histogram buckets (ms): `http_request_duration_ms` uses
`DURATION_BUCKETS_MS` = `[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]`;
the `perf_*` histograms use `PERF_DURATION_BUCKETS_MS` (same, plus a leading `1`).

---

## Notes

- **Isolated registry.** `Metrics` never touches prom-client's global default
  registry, so tests and multiple apps in one process stay independent. Get the
  raw registry with `metrics.getRegistry()` if you must.
- **Error-safe.** All middleware telemetry and all sink calls are guarded — a
  telemetry failure can never break a request or the measured code.
- **Cardinality.** Both the `route` label and the perf `name` label are meant for
  bounded vocabularies. Never emit per-request/per-entity unique label values.
