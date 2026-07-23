# Telemetry HTTP API — design

Date: 2026-07-23
Status: approved for planning
Packages: `@spinajs/telemetry` (extended), `@spinajs/metrics` (removed)

## 1. Context

The `Log stack fixes (#101)` commit landed `@spinajs/telemetry`: a private
`prom-client` registry, an HTTP timing middleware, `RequestStats` / `Timeline`
aggregates, and `PromMetricSink` bridging the `@spinajs/log` `Perf` facade into
Prometheus. It is a complete collection layer with **no HTTP surface** — the
package ships `metricsHandler()` / `statsHandler()` factories in
`src/endpoints.ts` and a README that tells consumers to "wire them into your own
router". There is no controller, no `src/config/`, and no policy.

Meanwhile `@spinajs/metrics` — the older package — owns the only routed
endpoint, `GET /metrics`, and renders prom-client's **global default** registry
via `express-prom-bundle`. Telemetry's registry is deliberately isolated from
that one. The consequence: in an app that installs both, the scrape endpoint
returns the express-prom-bundle series and **none** of the `http_*` / `perf_*`
series the new stack collects. The per-request `Perf` rollups, the ORM
`orm.query` spans, the Apdex score, and the rolling timeline are collected and
then unreachable.

Secondary problems in `@spinajs/metrics`:

- `Metrics.counter()` constructs a `client.Gauge`, not a `Counter`
  (`packages/metrics/src/index.ts:70-76`).
- `src/index.ts` declares a class `Metrics` and also re-exports the controller
  class `Metrics` from `./controllers/metrics.js`; the local declaration wins and
  the controller export is silently dropped.
- `README.md` is a leftover copy of `@spinajs/intl`'s.

## 2. Goals

- One observability package with one registry and one scrape endpoint.
- A routed, policy-guarded HTTP API that external tools can consume:
  Prometheus scrapers, Grafana, k8s probes, uptime monitors, custom dashboards.
- Config-driven behaviour (auth, buckets, caps, timeouts) rather than hardcoded
  class fields.
- Full OpenAPI documentation for every endpoint.

## 3. Non-goals

- Distributed tracing / OTLP export. `@spinajs/log-otlp` is a separate concern
  and `PerfSink` is the documented extension point for new destinations.
- Percentile estimation in-process. Percentiles remain Prometheus's job via
  `histogram_quantile` over `http_request_duration_ms`.
- Built-in health checks for DB / queue / cache. Telemetry ships the
  abstraction; the checks live where their dependency lives.
- A UI. The endpoints are machine-facing JSON and Prometheus text.

## 4. Decisions

| Decision | Choice |
|---|---|
| Package placement | Move everything into `@spinajs/telemetry`; delete `packages/metrics` |
| Endpoint set | `/metrics`, `/stats`, `/timeline`, `/routes`, `/perf`, `/health`, `/ready` |
| Auth | Token policy, selectable **per endpoint** through config |
| Registry | Unify on telemetry's private registry; drop `express-prom-bundle` |
| Percentiles on `/routes` | None — counts, avg/min/max, status classes, apdex |
| Built-in health checks | None — abstraction only |
| Swagger | Full OpenAPI response schemas |

## 5. Package consolidation

`packages/metrics` is deleted from the monorepo. `@spinajs/metrics` stays on npm
at its last published version (2.0.481) and is `npm deprecate`'d pointing at
`@spinajs/telemetry`; it simply stops being built and versioned here.

What moves:

| From `@spinajs/metrics` | Fate in `@spinajs/telemetry` |
|---|---|
| `DefaultMetricsPolicy` | → `src/policies/TelemetryTokenPolicy.ts`. Same semantics (dev bypass, `Forbidden` on missing/mismatched token, warn log with real IP). Header stays **`x-metrics-token`** so existing scrape configs keep working. Config key moves to `telemetry.auth.token`. |
| `controllers/metrics.ts` | → `src/controllers/Metrics.ts`, rewritten against the private registry. |
| `Metrics` wrapper class (`histogram`/`gauge`/`counter`/`summary` maps) | Dropped. `Metrics.defineMetrics()` supersedes it. Its only unique capability is `summary`, so `'summary'` is added to `MetricType` (see §7.1). |
| `collectDefaultMetrics()` on the global registry | Dropped. Replaced by `Metrics.collectDefault()` on the private registry, called from `TelemetryBootstrapper`, gated by `telemetry.collectDefaultMetrics`. |
| `express-prom-bundle` middleware | Dropped. `TelemetryMiddleware` already records method/route/status timing. Dependency removed. |
| `Gauge` / `Histogram` / `Summary` / `Counter` re-exports | Dropped. Import from `prom-client`, or declare via `defineMetrics`. |
| `README.md` | Not carried over (it is intl's README). |

`packages/telemetry/package.json` gains `@spinajs/configuration` (for `@Config`
and the config dir) and `@spinajs/exceptions` (for `Forbidden`). It already
depends on `@spinajs/http`, `@spinajs/log`, `@spinajs/di`, `prom-client`.

## 6. Endpoint contracts

Two controllers, so the Prometheus scrape URL stays byte-identical to today's:

- `@BasePath('metrics')` — the scrape endpoint. Keeping it off the `/telemetry`
  prefix means existing `scrape_configs` need no change.
- `@BasePath('telemetry')` — the JSON API.

| Method | Path | Policy config key | Default policy |
|---|---|---|---|
| GET | `/metrics` | `telemetry.auth.policies.metrics` | `TelemetryTokenPolicy` |
| GET | `/telemetry/stats` | `telemetry.auth.policies.stats` | `TelemetryTokenPolicy` |
| GET | `/telemetry/timeline` | `telemetry.auth.policies.timeline` | `TelemetryTokenPolicy` |
| GET | `/telemetry/routes` | `telemetry.auth.policies.routes` | `TelemetryTokenPolicy` |
| GET | `/telemetry/perf` | `telemetry.auth.policies.perf` | `TelemetryTokenPolicy` |
| GET | `/telemetry/health` | `telemetry.auth.policies.health` | `PublicPolicy` |
| GET | `/telemetry/ready` | `telemetry.auth.policies.ready` | `PublicPolicy` |

Per-endpoint policy needs no new machinery. `@Policy(string)` already resolves
the string as a **configuration key**, reads a policy class name out of it, and
resolves that from DI (`packages/http/src/controllers.ts:119-127`). Each route
carries `@Policy('telemetry.auth.policies.<name>')` and config decides which
class runs.

`/health` and `/ready` default to an explicit no-op `PublicPolicy` rather than an
empty config value: an unresolvable value makes the http layer log
`No policy named ... is registered` on every boot, which reads like a
misconfiguration and trains operators to ignore a real warning.

### 6.1 `GET /metrics`

Prometheus exposition text rendered from the private registry — `http_*`,
`perf_*`, and (when `telemetry.collectDefaultMetrics` is on) `process_*` /
`nodejs_*` in a single scrape.

Implemented as a `Response` subclass (like today's `PrometheusResponse`) so the
`Content-Type` comes from `registry.contentType` rather than being JSON-encoded.

- `200` — `text/plain; version=0.0.4; charset=utf-8`
- `403` — token missing or wrong

### 6.2 `GET /telemetry/stats`

`{ all, timeline }` — the exact shape today's `statsHandler` produces, so the
README's documented contract survives the move.

```jsonc
{
  "all": { "requests": 1284, "responses": 1284, "errors": 12,
           "info": 0, "success": 1201, "redirect": 60, "client_error": 11, "server_error": 1,
           "total_time": 48210, "max_time": 812, "min_time": 1, "avg_time": 37.5,
           "apdex_satisfied": 1180, "apdex_tolerated": 40, "apdex_score": 0.94,
           "req_rate": 0, "err_rate": 0 },
  "timeline": { "29014823": { /* IRequestStatsSnapshot */ } }
}
```

`req_rate` / `err_rate` are currently always 0 because nothing calls
`RequestStats.updateRates()`. The controller calls it with
`Date.now() - startedAt` before serialising, so the lifetime rates are real.

### 6.3 `GET /telemetry/timeline?buckets=N`

The timeline alone, most recent `N` buckets (default: all live buckets; `N` is
clamped to `telemetry.timeline.length`). Each bucket is annotated with its
window so consumers do not have to reverse the `floor(ts / bucketMs)` key:

```jsonc
{
  "bucketMs": 60000,
  "length": 60,
  "buckets": [
    { "key": 29014823, "from": 1740889380000, "to": 1740889440000, "stats": { /* … */ } }
  ]
}
```

`buckets` is validated by a `TimelineQuery` DTO (§9) — integer, `1..length`.

- `400` — `buckets` not a positive integer

### 6.4 `GET /telemetry/routes`

Per-route breakdown, the swagger-stats "API operations" view:

```jsonc
{
  "truncated": false,
  "routes": [
    { "method": "GET", "route": "/users/:id", "stats": { /* IRequestStatsSnapshot */ } }
  ]
}
```

No percentiles — `RequestStats` already carries requests, responses, errors,
status classes, `min`/`max`/`avg` time and apdex per route at zero extra cost.
Percentiles stay a Prometheus query over the per-route
`http_request_duration_ms` histogram, which is emitted with the same `route`
label.

`truncated` is `true` once the entry cap has been hit (§7.3), so a consumer can
tell "500 routes" from "500 routes and we stopped counting".

### 6.5 `GET /telemetry/perf`

Per-name rollup of everything the `Perf` facade has emitted in this process:

```jsonc
{
  "truncated": false,
  "spans":  [ { "name": "orm.query", "count": 8412, "totalMs": 61233.4, "avgMs": 7.28, "maxMs": 812.1 } ],
  "events": [ { "name": "cache.miss", "count": 219, "total": 219 } ]
}
```

Sorted by `totalMs` descending (spans) and `total` descending (events) so the
expensive things are at the top of the payload.

### 6.6 `GET /telemetry/health`

Liveness. Answers 200 whenever the process can serve a request; it runs no
checks, so it can never be made slow or flaky by a dependency.

```jsonc
{ "status": "up", "startedAt": 1740889380000, "uptimeMs": 84021, "pid": 4211,
  "version": "1.4.2", "node": "v20.11.1" }
```

`version` is whatever the host app puts in `telemetry.health.version`. It has no
default and the field is omitted from the response when unset — telemetry has no
reliable way to find the host app's version (`npm_package_version` is only set
under an npm script), and guessing wrong on a field operators use to confirm a
deploy is worse than omitting it.

### 6.7 `GET /telemetry/ready`

Readiness. Runs every registered `HealthCheck` (§7.4) concurrently, each raced
against `telemetry.health.timeoutMs`:

```jsonc
{
  "status": "degraded",
  "checks": [
    { "name": "database", "status": "up",       "durationMs": 3.1 },
    { "name": "queue",    "status": "degraded", "durationMs": 1204.5, "message": "broker reconnecting" }
  ]
}
```

- `200` — overall `up`, or `degraded` when `telemetry.health.failOnDegraded` is
  false (the default)
- `503` — any check `down`, or `degraded` when `failOnDegraded` is true

A check that throws or times out counts as `down` with the error message in
`message`. Returned via `new Ok(body, { StatusCode: 503 })` — `IResponseOptions`
already carries a `StatusCode` override
(`packages/http/src/interfaces.ts:264-268`), so no new response class is needed.

With no checks registered, `status` is `up` and `checks` is `[]`.

## 7. New and changed components

### 7.1 `Metrics` (changed)

- `MetricType` gains `'summary'`; `defineMetrics` constructs `client.Summary`
  for it, carrying `percentiles` through from an optional `MetricDef.percentiles`.
  This preserves the one capability the deleted `@spinajs/metrics` wrapper had
  that telemetry lacks.
- `collectDefault()` is unchanged; it is now called from the bootstrapper rather
  than by the consumer.

### 7.2 `TelemetryBootstrapper` (new)

`@Injectable(Bootstrapper)`. Replaces `MetricsBootstrapper`:

- resolves `Metrics` and calls `collectDefault()` when
  `telemetry.collectDefaultMetrics` is true;
- resolves `PromMetricSink` and `InMemoryPerfSink` and calls
  `Perf.refreshSinks()`, so the perf bridge is live in apps that use telemetry
  **without** `@spinajs/http`. `TelemetryMiddleware.resolve()` keeps doing the
  same for the http case; both are idempotent.

### 7.3 `TelemetryMiddleware` (changed)

Three changes:

1. **Config wiring.** `Prefix`, duration buckets, `RequestStats`' apdex
   threshold and `Timeline`'s length/bucket width are currently hardcoded class
   fields and constructor defaults. They become `@Config` reads with the present
   values as defaults, so the config tree in §8 is real rather than decorative.
   Subclass overriding of `Prefix` (documented in the README) keeps working: the
   config value is only applied when the subclass has not set it.
2. **Per-route stats.** A `Map<"METHOD route", RequestStats>` updated in
   `after()` alongside the existing global stats. Reuses `RequestStats`
   verbatim. Bounded by `telemetry.routes.maxEntries` (default 500): once full,
   new keys are dropped and a `truncated` flag is set, with a warn logged once.
   The bound matters — the `route` label falls back to `req.path` for unmatched
   requests (`middleware.ts:119-124`), so a 404-scanning bot would otherwise
   grow the map without limit. Disabled entirely by `telemetry.routes.enabled`.
3. **Rate window.** Records `startedAt` so `/stats` can compute `req_rate` /
   `err_rate`.

All of this stays inside the existing `try/catch` guards — telemetry must never
break a request.

### 7.4 `HealthCheck` + `HealthCheckRunner` (new)

```ts
export type HealthStatus = 'up' | 'degraded' | 'down';

export interface IHealthResult {
  status: HealthStatus;
  message?: string;
  data?: Record<string, unknown>;
}

export abstract class HealthCheck extends AsyncService {
  public abstract Name: string;
  public abstract check(): Promise<IHealthResult>;
}
```

Registered with `@Injectable(HealthCheck)`, discovered via
`Array.ofType(HealthCheck)`. `HealthCheckRunner` is a `@Singleton` that runs all
of them with `Promise.allSettled`, races each against the configured timeout,
maps rejection/timeout to `down`, times each one, and reduces to an overall
status (`down` beats `degraded` beats `up`).

Ships zero concrete checks. Adding a DB check would drag `@spinajs/orm` into the
observability package; that check belongs in `@spinajs/orm` or in the host app.

### 7.5 `InMemoryPerfSink` (new)

`@Singleton() @Injectable(PerfSink)`. `PromMetricSink` writes into prom
histograms, which are queryable from Prometheus but awkward to read back as
JSON — the bucket counts do not reconstruct a mean or a max. This sink keeps a
bounded `Map<name, { count, totalMs, maxMs }>` for spans and
`Map<name, { count, total }>` for counter/value events, capped at
`telemetry.perf.maxNames` (default 200, `truncated` flag once exceeded), gated
by `telemetry.perf.enabled`. `collect()` must not throw — the `Perf` facade
guards sinks, but a throwing sink still costs the try/catch on every
measurement.

`onScopeEnd` is not implemented here; per-request rollup totals are already
covered by `perf_scope_total_ms` on the Prometheus side and would double-count
against the same span names in the JSON view.

### 7.6 `TelemetryTokenPolicy` / `PublicPolicy` (new)

`TelemetryTokenPolicy` is `DefaultMetricsPolicy` moved and renamed, reading
`telemetry.auth.token`. `PublicPolicy` is a `BasePolicy` whose `execute()`
resolves immediately — an explicit "this endpoint is open" marker.

### 7.7 `endpoints.ts` (kept)

`metricsHandler` / `statsHandler` stay exported. They are the documented escape
hatch for consumers who mount telemetry on a bare express app without the
SpinaJS controller stack, and the controllers are thin enough that keeping both
costs nothing. The controllers do not call them (they need `Response` objects,
not `(req,res)` handlers), so the shared logic lives in `Metrics` /
`TelemetryMiddleware` where both can reach it.

## 8. Configuration

`packages/telemetry/src/config/telemetry.ts`, using the same `dir()` helper as
the deleted `packages/metrics/src/config/metrics.ts:3-6`:

```ts
{
  system: { dirs: { controllers: [dir('controllers')] } },

  telemetry: {
    auth: {
      token: '',                       // set this in your project
      policies: {
        metrics:  'TelemetryTokenPolicy',
        stats:    'TelemetryTokenPolicy',
        timeline: 'TelemetryTokenPolicy',
        routes:   'TelemetryTokenPolicy',
        perf:     'TelemetryTokenPolicy',
        health:   'PublicPolicy',
        ready:    'PublicPolicy',
      },
    },

    collectDefaultMetrics: true,
    prefix: 'http',
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    apdexThresholdMs: 25,

    timeline: { length: 60, bucketMs: 60_000 },
    routes:   { enabled: true, maxEntries: 500 },
    perf:     { enabled: true, maxNames: 200 },
    health:   { timeoutMs: 2000, failOnDegraded: false, version: undefined },
  },
}
```

## 9. OpenAPI

`http-swagger` builds responses from **JSDoc on the controller method** —
`@returns {Type}` and `@response <code>` tags (`openapi-builder.ts:820-860`) —
and resolves named types through `@Schema`-decorated classes via
`SCHEMA_SYMBOL` metadata. The JSDoc is read back from the emitted `.d.ts`
(`packages/http/src/cache.ts:135, 519`), which telemetry already ships under
`files: ["lib"]`.

So full OpenAPI coverage means:

- A `@Schema(...)`-decorated DTO class per response shape, in
  `src/dto/` with JSON schemas in `src/schemas/`, following the `@spinajs/orm-api`
  convention (`src/dto/QueryArgs.ts`): `RequestStatsSnapshot`, `StatsResponse`,
  `TimelineResponse`, `RoutesResponse`, `PerfResponse`, `HealthResponse`,
  `ReadyResponse`.
- `TimelineQuery` DTO for `?buckets=`, which also satisfies the strict
  validation enabled in #98 — without a schema the query arg is rejected.
- JSDoc on every controller method: a summary, `@returns {DtoName} description`,
  and `@response 403` / `@response 503` / `@response 400` where they apply.

`/metrics` returns `text/plain`, not JSON. Its JSDoc documents the 200 as a text
response; the builder's JSON-centric default is overridden by an explicit
`@response 200 {string}` tag rather than a `@returns`.

## 10. Testing

Per phase, tests first.

**Unit**

- `HealthCheckRunner`: all-up, one-down → `down`, degraded + `failOnDegraded`
  both ways, a check that throws → `down`, a check that hangs → `down` at the
  timeout (fake timers), empty registry → `up` with `[]`.
- `InMemoryPerfSink`: span aggregation (count/total/max), counter aggregation,
  name cap + `truncated`, disabled via config, never throws on a malformed
  metric.
- `TelemetryMiddleware` per-route map: keying by method+route, cap behaviour,
  `enabled: false`, config-driven prefix/buckets/apdex/timeline, and that a
  throwing metric call still calls `next()`.
- `RequestStats.updateRates` reachable from the stats assembly path.

**Controller / integration** (boot an http app with the telemetry config, as
`@spinajs/orm-api` tests do)

- `GET /metrics` → 200, `text/plain`, body contains `http_requests_total` after
  a request, and contains `perf_span_duration_ms` after a `Perf.measure`.
- Each JSON endpoint → 200 and a body matching its schema.
- Policy enforcement: 403 without the token in non-dev, 200 with it, 200 on
  `/health` and `/ready` without it.
- `?buckets=3` returns 3 buckets; `?buckets=abc` → 400.
- `/ready` → 503 with a deliberately-down check registered.
- No `metrics_*`/express-prom-bundle series present anywhere.

## 11. Migration

The breaking part is not the package rename — it is the **series rename**.
`express-prom-bundle` emitted seconds; telemetry emits milliseconds, with
different label names. Every dashboard panel and alert rule over the old series
breaks silently (the query returns no data rather than erroring).

| Before (`@spinajs/metrics` + express-prom-bundle) | After (`@spinajs/telemetry`) |
|---|---|
| `http_request_duration_seconds{status_code,method,path}` | `http_request_duration_ms{status,method,route}` |
| `http_requests_total{status_code,method,path}` | `http_requests_total{status,method,route}` |
| — | `http_requests_in_flight` |
| — | `perf_span_duration_ms{name}`, `perf_events_total{name}`, `perf_scope_total_ms{name}` |

Config:

| Before | After |
|---|---|
| `metrics.auth.token` | `telemetry.auth.token` |
| `metrics.auth.policy` | `telemetry.auth.policies.<endpoint>` |
| `metrics.http.*` (express-prom-bundle options) | removed — `telemetry.prefix`, `telemetry.buckets` |

Code:

| Before | After |
|---|---|
| `import { Gauge, Counter } from '@spinajs/metrics'` | `from 'prom-client'`, or `Metrics.defineMetrics()` |
| `new Metrics().histogram(name, cfg)` | `DI.get(Metrics).defineMetrics(prefix, [...])` |
| `DefaultMetricsPolicy` | `TelemetryTokenPolicy` |

The scrape path `/metrics` and the auth header `x-metrics-token` are unchanged,
so Prometheus `scrape_configs` need no edit.

This ships as a breaking change in release notes, with the table above.

## 12. Work order

1. Config file, `TelemetryTokenPolicy`, `PublicPolicy`, `TelemetryBootstrapper`,
   `'summary'` metric type. No routing yet.
2. `Metrics` controller (`GET /metrics`) + `Telemetry` controller with `/stats`
   and `/timeline`, DTOs and schemas for those, `updateRates` wiring.
3. `TelemetryMiddleware` config wiring + per-route stats → `/routes`.
4. `InMemoryPerfSink` → `/perf`.
5. `HealthCheck` / `HealthCheckRunner` → `/health`, `/ready`.
6. JSDoc + OpenAPI DTO coverage across all endpoints; verify the generated
   document.
7. Delete `packages/metrics`; update telemetry's README (endpoints, config,
   migration table); release notes.

Phases 1–5 each land with their tests. Phase 7 is the only irreversible one and
comes last, after the replacement is proven.

## 13. Risks

- **Silent dashboard breakage** from the series rename. Mitigated only by
  documentation and release notes; there is no compatibility shim (emitting both
  the seconds and milliseconds series would double the histogram cardinality for
  every route, which is worse).
- **Route-label cardinality.** The `route` label falls back to the raw path for
  unmatched requests. The `maxEntries` cap bounds the JSON view, but the
  Prometheus histogram has no such cap — an existing property of
  `TelemetryMiddleware`, not something this change introduces. Worth a README
  warning and a follow-up (collapse unmatched routes to a literal `unmatched`).
- **`PublicPolicy` on `/health` / `/ready`** exposes uptime, pid and version
  unauthenticated by default. That is the point (kubelet probes cannot carry a
  token), but the README must say so, and the config makes it a one-line change
  for anyone who disagrees.
