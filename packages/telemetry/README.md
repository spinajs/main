# `@spinajs/telemetry`

Observability for SpinaJS, derived from the swagger-stats design but adapted to
SpinaJS's DI + middleware conventions. It provides:

- **`Metrics`** — a `@Singleton()` wrapper over a private `prom-client` `Registry`
  (isolated from the global default registry) with a declarative metric factory
  (`defineMetrics`), default process metrics (`collectDefault`), and async
  Prometheus text rendering (`render` / `contentType`).
- **`TelemetryMiddleware`** — an `@Injectable(ServerMiddleware)` that times every
  HTTP request and records a duration **histogram**, a request **counter**, and
  an in-flight **gauge** (keyed by `method` / `route` / `status`), and feeds the
  shared `TelemetryStore`. All of it runs from a `res.on('finish')` handler, and
  telemetry errors never break the request.
- **`TelemetryStore`** — the `@Singleton()` that owns the collected aggregates
  (`RequestStats`, `Timeline`, `RouteStats`). The middleware is its only writer;
  the JSON endpoints are readers. It exists because a `ServerMiddleware` is not a
  singleton, so writer and reader cannot be the same object.
- **`PromMetricSink`** — an `@Injectable(PerfSink)` that bridges the
  `@spinajs/log` **`Perf`** facade to Prometheus: every `Perf.measure` /
  `@Measure` / `Perf.count` measurement (including the ORM `orm.query` spans and
  HTTP per-request rollups) is exported as a `perf_*` metric with **no extra
  wiring**.
- **`RequestStats`** — pure status-class counters (1xx..5xx), error rate, request
  rate, response-time min/max/avg, and **Apdex**.
- **`Timeline`** — a rolling ring of `RequestStats` buckets (default 60 x 1 min).
- **`RouteStats`** — a bounded per method+route breakdown.
- **controllers** — `/metrics` (Prometheus exposition) and a `/telemetry/*` JSON
  API, each guarded by a policy named in configuration. Registered automatically;
  the response DTOs carry schemas, so they show up in the generated OpenAPI
  document when `@spinajs/http-swagger` is installed.
- **`HealthCheck`** — the abstract readiness probe backing `/telemetry/ready`.
  The package ships no concrete checks; you register your own.
- **endpoint handlers** — `metricsHandler(metrics)` and `statsHandler(store)`,
  plain `(req, res)` handlers for apps that do not use the SpinaJS controller
  stack. Not needed otherwise; the controllers above cover it.

The registry is **isolated** (not `prom-client`'s global default), so multiple
SpinaJS apps in one process — and repeated init in tests — stay independent.

> Replacing `@spinajs/metrics`? Read
> [`docs/migrations/2026-07-23-metrics-to-telemetry.md`](../../docs/migrations/2026-07-23-metrics-to-telemetry.md)
> first — the http metric series are renamed **and** their unit changed from
> seconds to milliseconds, which takes dashboards down silently.

---

## Quick start

Install the package. The controllers, middleware, perf bridge and default
process metrics are wired automatically; set the auth token and you are done.

```ts
// configuration
{
  telemetry: {
    auth: { token: process.env.METRICS_TOKEN },
  },
}
```

| Endpoint | Returns | Default access |
| --- | --- | --- |
| `GET /metrics` | Prometheus exposition text | token |
| `GET /telemetry/stats` | `{ all, timeline }` — lifetime stats + rolling timeline | token |
| `GET /telemetry/timeline?buckets=N` | The timeline alone, buckets annotated with their window | token |
| `GET /telemetry/routes` | Per method+route request breakdown | token |
| `GET /telemetry/perf` | Aggregated `Perf` spans and events | token |
| `GET /telemetry/health` | Liveness — uptime, pid, node version, optional app version | public |
| `GET /telemetry/ready` | Readiness — runs every registered `HealthCheck`, 503 when any is down | public |

Guarded endpoints expect the token on the `x-metrics-token` header:

```bash
curl -H "x-metrics-token: $METRICS_TOKEN" http://localhost:8080/metrics
```

`TelemetryTokenPolicy` is bypassed entirely when `configuration.isDevelopment`
is set, so a local run needs no token at all.

Every endpoint's policy is a config key, so access can be changed without code:

```ts
telemetry: {
  auth: {
    policies: {
      metrics: 'TelemetryTokenPolicy',
      health: 'PublicPolicy',   // probes cannot carry a token
    },
  },
}
```

`/telemetry/health` and `/telemetry/ready` are public by default because kubelet
probes and load balancers cannot send a header. They expose uptime, pid, the node
version and — if you set `telemetry.health.version` — the app version. Point them
at `TelemetryTokenPolicy` if that is more than you want to publish.

### Readiness checks

Telemetry ships no concrete checks — a database check belongs where the database
dependency already is. Register your own:

```ts
import { Injectable } from '@spinajs/di';
import { HealthCheck, IHealthResult } from '@spinajs/telemetry';

@Injectable(HealthCheck)
export class DatabaseCheck extends HealthCheck {
  public Name = 'database';

  public async check(): Promise<IHealthResult> {
    try {
      await db.raw('select 1');
      return { status: 'up' };
    } catch (err) {
      return { status: 'down', message: (err as Error).message };
    }
  }
}
```

`status` is `'up' | 'degraded' | 'down'`; a check may also return a `data` bag.
Each check is raced against `telemetry.health.timeoutMs` ( default 2000 ), so a
hung dependency cannot hang the probe — a timed-out check, or one that throws,
counts as `down`. The overall status is the worst of them, and `/ready` answers
503 when it is `down` ( or `degraded`, with `telemetry.health.failOnDegraded` ).

### Mounting on a bare express app

`metricsHandler( metrics )` and `statsHandler( store )` are exported for apps
that do not use the SpinaJS controller stack:

```ts
import { DI } from '@spinajs/di';
import { Metrics, TelemetryStore, metricsHandler, statsHandler } from '@spinajs/telemetry';

router.get('/metrics', metricsHandler(await DI.resolve(Metrics)));
router.get('/telemetry/stats', statsHandler(await DI.resolve(TelemetryStore)));
```

These are unguarded — the policy lives on the controllers, so an app wiring the
handlers by hand owns its own auth. `statsHandler` also reports `req_rate` /
`err_rate` as whatever the last `/telemetry/stats` controller call left behind
( `0` if nobody has called it ), because only the controller derives them.

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
are **configuration**, not code — do not subclass just to change them:

```ts
// configuration
{
  telemetry: {
    prefix: 'api', // -> api_requests_total, api_request_duration_ms, api_requests_in_flight
    buckets: [5, 25, 100, 500, 2500],
  },
}
```

> **Do not subclass `TelemetryMiddleware` to re-prefix.** Decorating a subclass
> with `@Injectable(ServerMiddleware)` **adds** a middleware, it does not replace
> the base one — see [Replacing the middleware](#replacing-the-middleware). You
> would get `http_*` **and** `api_*` for every request, plus double counts in
> `/telemetry/stats`.

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

`MetricDef.type` is `'counter' | 'gauge' | 'histogram' | 'summary'`; `labelNames`
is optional, as are `buckets` (histogram only) and `percentiles` (summary only).
Every name is prefixed with `${prefix}_`, so pass the base name. Keep label
**values** low-cardinality — never put ids, emails, or raw URLs in a label.

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

`TelemetryBootstrapper` builds both sinks and calls `Perf.refreshSinks()` at
startup, so the bridge is live for every app that has this package installed —
with or without `@spinajs/http`. Nothing to wire.

It builds them through `Array.ofType(PerfSink)` rather than
`DI.resolve(PromMetricSink)`, and that detail is load-bearing: the container
caches a directly-resolved instance under its own type name only, and a later
`Array.ofType(PerfSink)` returns that cached instance **without** adding it to
the `PerfSink` list — leaving `Perf` blind to the sink it just handed back. If
you add a sink of your own, resolve it the same way.

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

`statsHandler(store)` writes `{ all, timeline }` from the shared store's lifetime
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
| `process_*` / `nodejs_*` | various | — | `metrics.collectDefault()`, called at bootstrap unless `telemetry.collectDefaultMetrics` is `false` |

Duration histogram buckets (ms): `http_request_duration_ms` uses
`DURATION_BUCKETS_MS` = `[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]`;
the `perf_*` histograms use `PERF_DURATION_BUCKETS_MS` (same, plus a leading `1`).

---

## Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `telemetry.auth.token` | `''` | Expected value of the `x-metrics-token` header |
| `telemetry.auth.policies.<endpoint>` | see below | Policy class name per endpoint |
| `telemetry.collectDefaultMetrics` | `true` | Register `process_*` / `nodejs_*` metrics at bootstrap |
| `telemetry.prefix` | `'http'` | Metric name prefix for the http metrics |
| `telemetry.buckets` | `[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]` | Duration histogram buckets ( ms ) |
| `telemetry.apdexThresholdMs` | `25` | Apdex satisfied threshold; tolerated is 4x |
| `telemetry.timeline.length` | `60` | Buckets retained in the timeline ring |
| `telemetry.timeline.bucketMs` | `60000` | Timeline bucket width ( ms ) |
| `telemetry.routes.enabled` | `true` | Collect the per-route breakdown |
| `telemetry.routes.maxEntries` | `500` | Cap on distinct method+route keys |
| `telemetry.perf.enabled` | `true` | Collect the in-memory perf aggregate behind `/telemetry/perf` |
| `telemetry.perf.maxNames` | `200` | Cap on distinct perf measurement names |
| `telemetry.health.timeoutMs` | `2000` | Per-check timeout for `/telemetry/ready` |
| `telemetry.health.failOnDegraded` | `false` | Serve 503 for a degraded overall status |
| `telemetry.health.version` | unset | Version string reported by `/telemetry/health`; omitted from the response when unset |

The `<endpoint>` keys are `metrics`, `stats`, `timeline`, `routes`, `perf`,
`health` and `ready`. Policy defaults: `TelemetryTokenPolicy` for `metrics`,
`stats`, `timeline`, `routes` and `perf`; `PublicPolicy` for `health` and
`ready`.

`telemetry.perf.enabled` and `telemetry.perf.maxNames` bound the **JSON** view
only ( `InMemoryPerfSink` ). The `perf_*` Prometheus series come from a separate
sink and are unaffected by either.

### Cardinality

Both the `route` label and the perf `name` label are meant for bounded
vocabularies. The `maxEntries` / `maxNames` caps bound the JSON views, but the
Prometheus histograms have no such cap — the `route` label falls back to the raw
request path when no route matched, so a 404-scanning bot inflates the series
count. Put telemetry behind a router that 404s unmatched paths early, or subclass
`TelemetryMiddleware` and override `routeLabel()` to collapse unmatched requests
to a constant:

```ts
import { DI, Injectable } from '@spinajs/di';
import { ServerMiddleware, Request as sRequest } from '@spinajs/http';
import { TelemetryMiddleware } from '@spinajs/telemetry';

@Injectable(ServerMiddleware)
export class BoundedTelemetry extends TelemetryMiddleware {
  protected routeLabel(req: sRequest): string {
    const matched = (req as any).route?.path ?? (req.storage as any)?.route;
    // anything the router never matched collapses to one series
    return typeof matched === 'string' && matched.length > 0 ? matched : '__unmatched__';
  }
}

// REQUIRED — drop the base registration, otherwise BOTH middlewares run.
// See "Replacing the middleware" below.
DI.unregister(TelemetryMiddleware);
```

### Replacing the middleware

`@Injectable(ServerMiddleware)` **appends** to the `ServerMiddleware` registration
list — it does not displace the base class. `TelemetryMiddleware` registers itself
when `@spinajs/telemetry` is imported, so a subclass that carries its own
`@Injectable(ServerMiddleware)` leaves **two** telemetry middlewares registered.
`HttpServer` resolves all of them (`@Autoinject(ServerMiddleware)`), so both run
on every request:

- both write to the same singleton `TelemetryStore`, so `/telemetry/stats`,
  `/telemetry/timeline` and `/telemetry/routes` report **double** the real
  counts;
- both call `ensureMetrics()` with the same prefix, and `defineMetrics()`
  removes-and-recreates a duplicate name, so one of the two instances ends up
  holding **deregistered** metric objects — whose `routeLabel()` reaches the live
  histogram then depends on middleware ordering.

Remove the base registration with `DI.unregister()`:

```ts
import { DI } from '@spinajs/di';
import { TelemetryMiddleware } from '@spinajs/telemetry';
import { BoundedTelemetry } from './BoundedTelemetry.js'; // must be imported, so its @Injectable has run

DI.unregister(TelemetryMiddleware);
```

Two rules:

1. Run it **after** both modules are imported ( the decorators register at import
   time ) and **before** `HttpServer` is resolved — the middleware list is read
   once, when the server is resolved.
2. `unregister` matches by **type name**, so it removes only
   `TelemetryMiddleware`; your subclass stays registered.

If you only need a different prefix or different buckets, do **not** subclass at
all — use the `telemetry.prefix` / `telemetry.buckets` config keys.

---

## Notes

- **Isolated registry.** `Metrics` never touches prom-client's global default
  registry, so tests and multiple apps in one process stay independent. Get the
  raw registry with `metrics.getRegistry()` if you must.
- **Error-safe.** All middleware telemetry and all sink calls are guarded — a
  telemetry failure can never break a request or the measured code.
- **Cardinality.** Both the `route` label and the perf `name` label are meant for
  bounded vocabularies. Never emit per-request/per-entity unique label values —
  see [Cardinality](#cardinality) for the unmatched-path case, which is the one
  that bites without you doing anything wrong.
- **Migrating from `@spinajs/metrics`?** See
  [`docs/migrations/2026-07-23-metrics-to-telemetry.md`](../../docs/migrations/2026-07-23-metrics-to-telemetry.md).
