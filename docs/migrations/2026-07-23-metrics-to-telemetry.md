# Migrating from `@spinajs/metrics` to `@spinajs/telemetry`

`@spinajs/metrics` is removed. `@spinajs/telemetry` replaces it and adds a JSON
telemetry API, per-request performance metrics and health/readiness probes.

> **Read the two "silent failure" sections first.** Both of them break existing
> dashboards without producing an error anywhere: the http series are renamed,
> and the registry `/metrics` renders is no longer prom-client's global one.

---

## Silent failure 1: the http metric series are renamed

`@spinajs/metrics` collected http metrics with
[`express-prom-bundle`](https://github.com/jochen-schweizer/express-prom-bundle),
which reports **seconds**. `@spinajs/telemetry` reports **milliseconds**, with
different label names. A PromQL query over a series that no longer exists returns
no data rather than erroring, so dashboards go blank and alerts go quiet instead
of red. Update them before you deploy.

| Before ( `@spinajs/metrics` ) | After ( `@spinajs/telemetry` ) | Note |
| --- | --- | --- |
| `http_request_duration_seconds{status_code,method,path}` | `http_request_duration_ms{status,method,route}` | histogram; **unit changed s -> ms**, all three labels renamed |
| `http_request_duration_seconds_count{...}` | `http_requests_total{status,method,route}` | request count is now a dedicated counter |
| `up` | — | **removed**; use `GET /telemetry/health` or `process_start_time_seconds` |
| — | `http_requests_in_flight` | new gauge, no labels |
| — | `perf_span_duration_ms{name}` | new — every `Perf.measure` / `@Measure` span |
| — | `perf_events_total{name}` | new — every `Perf.count` / `Perf.value` |
| — | `perf_scope_total_ms{name}` | new — per-request rollup totals |

Note that `http_requests_total` did **not** exist before. `express-prom-bundle`
only emitted the duration histogram, so any "request rate" panel was built on
`rate( http_request_duration_seconds_count[5m] )`. It can now be built on
`rate( http_requests_total[5m] )`, which is cheaper and clearer — but the
histogram's `_count` still works if you would rather not touch it.

### Rewriting queries

```promql
# before — p95 latency, result in SECONDS
histogram_quantile( 0.95, sum by (le) ( rate( http_request_duration_seconds_bucket[5m] ) ) )

# after — p95 latency, result in MILLISECONDS
histogram_quantile( 0.95, sum by (le) ( rate( http_request_duration_ms_bucket[5m] ) ) )
```

```promql
# before — 5xx rate
sum( rate( http_request_duration_seconds_count{status_code=~"5.."}[5m] ) )

# after — 5xx rate
sum( rate( http_requests_total{status=~"5.."}[5m] ) )
```

Anything that compared a duration against a threshold must be rescaled by 1000.
A `> 0.5` alert on the old series means 500 ms and becomes `> 500`. Grafana
panels with a `s` unit need switching to `ms`.

### The label *values* changed too, not just the names

- `status_code` -> `status`. Same values ( `"200"`, `"404"`, ... ); the label is
  a string in both.
- `method` -> `method`. Unchanged.
- `path` -> `route`. **The values differ.** `express-prom-bundle` normalised the
  raw `originalUrl` by substituting `#val` for anything that looked like an id,
  giving `/users/#val`. Telemetry uses the *matched express route path*, giving
  `/users/:id`, and only falls back to the raw request path when no route
  matched. Any query that matches on a label value — `path="/users/#val"` —
  must be rewritten against the new vocabulary.

### Bucket boundaries changed

`express-prom-bundle`'s defaults were `[ 0.003, 0.03, 0.1, 0.3, 1.5, 10 ]`
seconds ( 3 ms, 30 ms, 100 ms, 300 ms, 1.5 s, 10 s ). Telemetry's default is
`[ 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000 ]` ms — finer at the
low end. Quantiles interpolated from the old, coarse buckets are not comparable
with the new ones, so expect a step change in any p95/p99 panel at cutover even
where the underlying latency did not move. Override with `telemetry.buckets` if
you need to keep the old shape.

### Unchanged

The scrape path is still `/metrics` and the auth header is still
`x-metrics-token`, so Prometheus `scrape_configs` need no edit.

---

## Silent failure 2: `/metrics` now renders a private registry

`@spinajs/metrics` served prom-client's **global default registry**
( `client.register` ). `@spinajs/telemetry` owns a **private** `Registry`, so
that multiple SpinaJS apps in one process — and repeated init in tests — stay
independent.

The consequence: application metrics you constructed directly, like

```ts
// registers on prom-client's GLOBAL registry, because that is prom-client's default
const orders = new Histogram( { name: 'orders_value_eur', help: '...', buckets: [ 10, 50, 100 ] } );
```

still record fine, but **no longer appear in the `/metrics` response**. Nothing
throws. Either declare them through the telemetry registry:

```ts
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry';
import type { Histogram } from 'prom-client';

const metrics = await DI.resolve( Metrics );

const map = metrics.defineMetrics( 'orders', [
  { name: 'value_eur', help: 'Order value in EUR', type: 'histogram', buckets: [ 10, 50, 100 ] },
] );

( map[ 'value_eur' ] as Histogram<string> ).observe( 129.9 );
// -> orders_value_eur
```

…or, if you must keep constructing prom-client objects yourself, point them at
the telemetry registry explicitly:

```ts
const registry = ( await DI.resolve( Metrics ) ).getRegistry();
const orders = new Histogram( { name: 'orders_value_eur', help: '...', registers: [ registry ] } );
```

Note that `defineMetrics( prefix, defs )` **prefixes** every name it builds
( `'orders'` + `'value_eur'` -> `orders_value_eur` ), so pass the base name, not
the full one.

### `process_*` / `nodejs_*` lost their `NODE_APP_INSTANCE` label

`@spinajs/metrics` called
`collectDefaultMetrics( { labels: { NODE_APP_INSTANCE: process.env.NODE_APP_INSTANCE } } )`
unconditionally. Telemetry registers the same default metric set — gated on
`telemetry.collectDefaultMetrics`, default `true` — but **without** that label.
Any query grouping process metrics by `NODE_APP_INSTANCE` needs another way to
distinguish instances; the usual one is a target label in `scrape_configs`.

---

## Configuration

| Before | After |
| --- | --- |
| `metrics.auth.token` | `telemetry.auth.token` |
| `metrics.auth.policy` — one policy for the whole controller | `telemetry.auth.policies.<endpoint>` — one key per endpoint |
| `metrics.http.*` ( `express-prom-bundle` options ) | removed; use `telemetry.prefix` and `telemetry.buckets` |
| — | `telemetry.collectDefaultMetrics`, `telemetry.apdexThresholdMs`, `telemetry.timeline.*`, `telemetry.routes.*`, `telemetry.perf.*`, `telemetry.health.*` |

`metrics.http.includeStatusCode` / `includeMethod` / `includePath` have no
equivalent and are not needed: telemetry always emits all three labels.

The full key-by-key reference, with defaults, is in
[`packages/telemetry/README.md`](../../packages/telemetry/README.md#configuration-reference).

### Policy defaults

`TelemetryTokenPolicy` for `metrics`, `stats`, `timeline`, `routes` and `perf`;
`PublicPolicy` for `health` and `ready`. The probes are public by default because
kubelet probes and load balancers cannot send a header. Point them at
`TelemetryTokenPolicy` if uptime, pid and version are more than you want to
publish:

```ts
telemetry: {
  auth: {
    policies: {
      health: 'TelemetryTokenPolicy',
      ready: 'TelemetryTokenPolicy',
    },
  },
}
```

`TelemetryTokenPolicy` is bypassed entirely when `configuration.isDevelopment`
is set, exactly as `DefaultMetricsPolicy` was — that behaviour is carried over
unchanged. `PublicPolicy` permits everything unconditionally; it exists only so
the config can name a real class for the probe endpoints, since the http layer
logs `No policy named ... is registered` on every boot for an empty value.

---

## Code

| Before | After |
| --- | --- |
| `import { Gauge, Counter, Histogram, Summary } from '@spinajs/metrics'` | `import { Gauge, Counter, Histogram, Summary } from 'prom-client'` |
| `new Metrics().histogram( name, cfg )` | `( await DI.resolve( Metrics ) ).defineMetrics( prefix, [ { name, help, type: 'histogram' } ] )` |
| `new Metrics().gauge( ... )` / `.counter( ... )` / `.summary( ... )` | same `defineMetrics` call with `type: 'gauge'` / `'counter'` / `'summary'` |
| `DefaultMetricsPolicy` | `TelemetryTokenPolicy` |
| `MetricsBootstrapper` | `TelemetryBootstrapper` — self-registering, exactly as `MetricsBootstrapper` was; nothing to wire |
| `statsHandler( mw )` | `statsHandler( store )` — see below |

The old `Metrics` was a plain class you instantiated per call site, each with its
own private maps. The new one is a `@Singleton()`; resolve it from DI so every
caller shares one registry.

### `Metrics.counter()` built a gauge

The old wrapper's `counter()` method constructed a `client.Gauge`, not a
`client.Counter`:

```ts
public counter<T extends string>( name: string, configuration: client.CounterConfiguration<T> ) {
  if ( !this._counters.has( name ) ) {
    this._counters.set( name, new client.Gauge( configuration ) );  // <- Gauge
  }
  ...
}
```

So anything registered through it exposed a gauge-shaped series and accepted
`.set()` / `.dec()`. After migrating, `type: 'counter'` gives a real counter:
monotonic, `.inc()` only, and `rate()` over it finally means what it says.
Anything that called `.set()` or `.dec()` on one of those "counters" must become
a `type: 'gauge'`.

### `statsHandler` takes the store, not the middleware

This one only affects code written against an early `@spinajs/telemetry`
pre-release — it is listed here because it is a breaking change to an exported
symbol shipping in the same release as this removal.

```ts
// before
router.get( '/telemetry/stats', statsHandler( middleware ) );

// after — the aggregates moved off the middleware onto a shared singleton
import { TelemetryStore, statsHandler } from '@spinajs/telemetry';

const store = await DI.resolve( TelemetryStore );
router.get( '/telemetry/stats', statsHandler( store ) );
```

`TelemetryMiddleware` is an `@Injectable( ServerMiddleware )` and therefore not a
singleton, so the instance express mounts was never the instance a reader got
from `@Autoinject` — the handler read an object nothing wrote to.
`TelemetryStore` is the `@Singleton()` that now owns `RequestStats`, `Timeline`
and `RouteStats`.

**You almost certainly do not need this handler.** Telemetry ships controllers
for every endpoint and registers its own controller directory, so `/metrics` and
the `/telemetry/*` routes exist as soon as the package is installed.
`metricsHandler` and `statsHandler` remain exported only for apps that do not use
the SpinaJS controller stack.

---

## What you gain

Additive, nothing to migrate — but the reason the swap is worth doing:

| Endpoint | Returns |
| --- | --- |
| `GET /telemetry/stats` | Lifetime request stats ( status classes, error rate, Apdex ) plus the rolling timeline |
| `GET /telemetry/timeline?buckets=N` | The timeline alone, each bucket annotated with the wall-clock window it covers |
| `GET /telemetry/routes` | Per method+route request breakdown |
| `GET /telemetry/perf` | Aggregated `Perf` spans and events, including the ORM's `orm.query` |
| `GET /telemetry/health` | Liveness — uptime, pid, node version, optional app version |
| `GET /telemetry/ready` | Readiness — runs every registered `HealthCheck`, 503 when any is down |

Plus the `perf_*` bridge: every `Perf.measure` / `@Measure` / `Perf.count` in the
process — the ORM's query spans included — is exported to Prometheus with no
wiring at all. `@spinajs/metrics` had no equivalent.

All six JSON endpoints carry response schemas, so they appear in the generated
OpenAPI document when `@spinajs/http-swagger` is installed.

---

## Steps

1. `npm uninstall @spinajs/metrics && npm install @spinajs/telemetry`
2. Rename the config keys per the [Configuration](#configuration) table.
3. Replace `@spinajs/metrics` imports per the [Code](#code) table. Drop any
   `MetricsBootstrapper` wiring — `TelemetryBootstrapper` is automatic.
4. Re-declare any directly-constructed prom-client metrics against the telemetry
   registry, or they vanish from `/metrics` — see
   [Silent failure 2](#silent-failure-2-metrics-now-renders-a-private-registry).
5. Update dashboards, recording rules and alert rules for the renamed series and
   the seconds -> milliseconds change — see
   [Silent failure 1](#silent-failure-1-the-http-metric-series-are-renamed).
   Budget for a step change in latency quantiles from the new bucket boundaries.
6. Optionally set `telemetry.health.version` and register `HealthCheck`
   implementations so `GET /telemetry/ready` says something useful.

### Running both during the cutover

There is no dual-emit mode, and there is no point building one: the two packages
both serve `/metrics` on their own controller, and the old one wrote to the
global registry while the new one writes to a private one. If you need overlap,
keep the old dashboards alongside new ones and let the old series age out of
retention — the metric names do not collide, so both sets can coexist in
Prometheus for as long as your retention window.
