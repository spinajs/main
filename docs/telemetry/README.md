# `@spinajs/telemetry`

Observability for SpinaJS apps: Prometheus metrics on `/metrics`, a request-timing middleware, Apdex and rolling request statistics, a `Perf` bridge, and liveness and readiness probes under `/telemetry/*`. Every data endpoint is guarded through the SpinaJS 3.0 authz layer.

It does **not** ship concrete readiness checks: you register a `HealthCheck` per dependency. It does **not** export traces: OpenTelemetry tracing is `@spinajs/telemetry-otel`. The `Metrics` registry itself lives in `@spinajs/telemetry-common`, which this package re-exports.

## Install

```sh
npm install @spinajs/telemetry
```

Import the package barrel once (`import '@spinajs/telemetry'`). The import registers the middleware, the perf sinks, the policies, the bootstrappers and the configuration schema. The package configuration adds the controllers directory, so the endpoints mount without code.

## Features

| Feature | What it does |
| --- | --- |
| [Setup and configuration](01-setup-and-configuration.md) | What loading the package registers, the two bootstrappers, every `telemetry.*` key and the configuration schema |
| [Prometheus registry](02-prometheus-registry.md) | The `Metrics` singleton: a private prom-client registry, `defineMetrics()`, default process metrics, rendering |
| [HTTP request metrics](03-http-request-metrics.md) | `TelemetryMiddleware`: the `http_*` counter, histogram and in-flight gauge, and how a request is timed |
| [Customizing the request middleware](04-customizing-the-request-middleware.md) | Subclass `TelemetryMiddleware` (route label, prefix) and replace the shipped registration without double counting |
| [Request statistics](05-request-statistics.md) | `TelemetryStore`, `RequestStats`, `Timeline`, `RouteStats`, Apdex, and the `stats`, `timeline` and `routes` endpoints |
| [Perf bridge](06-perf-bridge.md) | `PromMetricSink` and `InMemoryPerfSink`: every `Perf` measurement as `perf_*` series and as `/telemetry/perf` JSON |
| [Custom perf sinks](07-custom-perf-sinks.md) | Add, replace or remove a `PerfSink` next to the shipped ones |
| [Health and readiness](08-health-and-readiness.md) | `/telemetry/health`, `/telemetry/ready`, `HealthCheck` and `HealthCheckRunner` |
| [Endpoints and OpenAPI](09-endpoints-and-openapi.md) | The two controllers, response shapes, `PrometheusResponse`, `ServiceUnavailable`, the DTO schemas, and handlers for a bare express app |
| [Endpoint access](10-endpoint-access.md) | `telemetry.auth.*` slots, `TelemetryAccessPolicy`, `TelemetryAccessContributor`, the development skip, the deprecated token policy |
| [Custom access policies](11-custom-access-policies.md) | Name your own `BasePolicy` in a slot, and guard your own routes with `@TelemetryAccess()` |
| [Scrape token](12-scrape-token.md) | `telemetry.auth.token` as the service principal `service:telemetry`, and the RBAC role it gets |

## Quick start

```ts sample
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry';
import type { Counter } from '@spinajs/telemetry';

// configuration: the scrape token becomes the principal `service:telemetry`
export const config = {
  telemetry: {
    auth: { token: process.env.METRICS_TOKEN ?? '' },
  },
};

// count signups next to the built-in http_* and perf_* series on GET /metrics
const metrics = DI.get(Metrics) ?? DI.resolve(Metrics);
const { signups_total } = metrics.defineMetrics('app', [{ name: 'signups_total', help: 'Completed signups', type: 'counter', labelNames: ['plan'] }]);

export function onSignup(plan: 'free' | 'pro'): void {
  (signups_total as Counter<string>).inc({ plan });
}
```

```bash
curl -H "x-metrics-token: $METRICS_TOKEN" http://localhost:8080/metrics
```

| Endpoint | Returns | Default access |
| --- | --- | --- |
| `GET /metrics` | Prometheus exposition text | `telemetry:read` |
| `GET /telemetry/stats` | `{ all, timeline }`: lifetime stats and the rolling timeline | `telemetry:read` |
| `GET /telemetry/timeline?buckets=N` | The timeline alone, each bucket annotated with its window | `telemetry:read` |
| `GET /telemetry/routes` | Per method+route request breakdown | `telemetry:read` |
| `GET /telemetry/perf` | Aggregated `Perf` spans and events | `telemetry:read` |
| `GET /telemetry/health` | Liveness: uptime, pid, node version, optional app version | public |
| `GET /telemetry/ready` | Readiness: runs every registered `HealthCheck`, 503 when one is down | public |

## Related packages

- [`@spinajs/http`](../http/README.md): the server, the `ServerMiddleware` list and the `BasePolicy` contract this package plugs into.
- [`@spinajs/log`](../log/15-performance-measurement.md): the `Perf` facade the perf bridge listens to.
- [`@spinajs/authz`](../authz/README.md): permissions, RBAC roles and `authz.http.services`, which decide who reads the endpoints.
- [`@spinajs/http-swagger`](../http-swagger/README.md): picks up the response DTO schemas for the OpenAPI document.
- [`@spinajs/orm`](../orm/13-observability-and-resilience.md) and [`@spinajs/http-socket`](../http-socket/16-observability.md): publish their own series into the same `Metrics` registry, so `/metrics` renders them too.
