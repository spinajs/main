# Endpoints and OpenAPI

Two controllers serve the telemetry HTTP API: `MetricsController` at `/metrics` and `TelemetryController` under `/telemetry`. Their response DTOs carry JSON schemas, so `@spinajs/http-swagger` documents them. Apps without the SpinaJS controller stack mount `metricsHandler()` and `statsHandler()` instead.

## How it works

1. The package config adds its `controllers` directory to `system.dirs.controllers`; `@spinajs/http` discovers and mounts both controllers.
2. Each controller module imports `PublicPolicy`, `TelemetryTokenPolicy`, `TelemetryAccessPolicy` and the configuration schema, so every slot name resolves without the package barrel.
3. `controllers/Telemetry.ts` imports the DTO module. Its `@Schema()` decorators register `StatsResponse`, `TimelineResponse`, `RoutesResponse`, `PerfResponse`, `HealthResponse` and `ReadyResponse` by class name.
4. Every route carries `@TelemetryAccess('<endpoint>')`; see [Endpoint access](10-endpoint-access.md).
5. `GET /metrics` returns a `PrometheusResponse`. It bypasses the JSON and pug pipeline: it awaits `Metrics.render()` and writes the text with `Metrics.contentType()`.

## HTTP surface

| Route | Slot | Success | Errors | Body |
| --- | --- | --- | --- | --- |
| `GET /metrics` | `metrics` | 200 | 401, 403 | Prometheus exposition text |
| `GET /telemetry/stats` | `stats` | 200 | 401, 403 | `StatsResponse`: `{ all: IRequestStatsSnapshot, timeline: Record<key, IRequestStatsSnapshot> }` |
| `GET /telemetry/timeline?buckets=N` | `timeline` | 200 | 400, 401, 403 | `TimelineResponse`: `{ bucketMs, length, buckets: [{ key, from, to, stats }] }`, ascending by key |
| `GET /telemetry/routes` | `routes` | 200 | 401, 403 | `RoutesResponse`: `{ truncated, routes: [{ method, route, stats }] }` |
| `GET /telemetry/perf` | `perf` | 200 | 401, 403 | `PerfResponse`: `{ truncated, spans, events }` |
| `GET /telemetry/health` | `health` | 200 | none by default | `HealthResponse`: `{ status: 'up', startedAt, uptimeMs, pid, node, version? }` |
| `GET /telemetry/ready` | `ready` | 200 | 503 | `ReadyResponse`: `{ status, checks: [{ name, status, durationMs, message?, data? }] }` |

- 401: no principal; with the defaults, no valid scrape token in `x-metrics-token` or `Authorization: Bearer`.
- 403: a principal without the slot's permission. The body names the permission (`{ error: 'forbidden', permission: 'telemetry:read', ... }`).
- 400: `buckets` is present and not a positive integer; message `buckets must be a positive integer`.
- 503: the readiness report is failing; the body is still the report.

`/metrics` stays at the bare path, not under `/telemetry`, because existing `scrape_configs` point there.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Controllers | discovered from `system.dirs.controllers`; `BaseController` | `MetricsController`, `TelemetryController` | your controllers | Add routes in your own controller; reuse `@TelemetryAccess()` and the responses below |
| Prometheus response | none; `new PrometheusResponse(metrics)` | `PrometheusResponse` | any `Response` | Return it from your own action to expose the registry at another path |
| 503 response | none; `new ServiceUnavailable(body)` | `ServiceUnavailable` | any `Response` | Return it from any action that must answer 503 with a body |
| Response DTOs | `@Schema()` registrations in the `'__schemas__'` map, by class name | `StatsResponse`, `TimelineResponse`, `RoutesResponse`, `PerfResponse`, `HealthResponse`, `ReadyResponse` | your DTOs | Reference them in `@returns {Name}` JSDoc of your actions |
| Bare handlers | functions, no DI | `metricsHandler(metrics)`, `statsHandler(store)` | your handler | Mount them on any router that passes `(req, res)` with `setHeader()` and `end()` |

### `PrometheusResponse`: expose the registry on an internal path

Serve the same registry on a second path, e.g. for a sidecar that cannot be configured with a token, guarded by a slot of its own.

```ts sample
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Get } from '@spinajs/http';
import { Metrics, PrometheusResponse, TelemetryAccess } from '@spinajs/telemetry';

// config: telemetry.auth.policies.internalMetrics = 'InternalNetworkPolicy' (see Custom access policies)
@BasePath('internal')
export class InternalMetricsController extends BaseController {
  @Autoinject(Metrics)
  protected Metrics!: Metrics;

  /**
   * Prometheus exposition text for the cluster network.
   *
   * @response 200 {string} Prometheus exposition text
   */
  @Get('metrics')
  @TelemetryAccess('internalMetrics')
  public async metrics() {
    return new PrometheusResponse(this.Metrics);
  }
}
```

### `ServiceUnavailable`: answer 503 during maintenance

```ts sample
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { ServiceUnavailable } from '@spinajs/telemetry';

let maintenanceUntil: number | undefined;

@BasePath('status')
export class MaintenanceController extends BaseController {
  @Get('/')
  public async status() {
    if (maintenanceUntil !== undefined && maintenanceUntil > Date.now()) {
      return new ServiceUnavailable({ status: 'maintenance', until: new Date(maintenanceUntil).toISOString() });
    }
    return new Ok({ status: 'ok' });
  }
}
```

## Important behaviour

- The handlers `metricsHandler()` and `statsHandler()` are unguarded. The access check lives on the controllers; an app that mounts the handlers owns its own auth.
- `statsHandler()` writes `{ all, timeline }` like `/telemetry/stats` and refreshes the lifetime rates the same way.
- `new Ok(body, { StatusCode: 503 })` answers 200: `Response.execute()` overwrites the status with the class's own code. Use `ServiceUnavailable`.
- The DTO classes are never instantiated. They exist so `@Schema()` registers each schema under the class name.
- A slot that cannot be honoured makes the whole controller fail to register, probes included. The app does not start with an open route.

## Best practices

- Install `@spinajs/http-swagger` to get the telemetry endpoints, with their 401, 403, 400 and 503 responses, in the generated OpenAPI document.
- Prefer the controllers to the bare handlers; they bring the access check and the rate computation.
- Keep `/metrics` at the root path, so default Prometheus scrape configs work unchanged.

## Patterns and antipatterns

```ts
// Don't: the status option is overwritten; this answers 200
return new Ok(report, { StatusCode: 503 });

// Do
return new ServiceUnavailable(report);
```

## Examples

### Mount the handlers on a bare express app

```ts sample
import express from 'express';
import { DI } from '@spinajs/di';
import { Metrics, TelemetryStore, metricsHandler, statsHandler } from '@spinajs/telemetry';

export async function mountTelemetry(app: express.Express, token: string): Promise<void> {
  const metrics = DI.get(Metrics) ?? DI.resolve(Metrics);
  const store = await DI.resolve(TelemetryStore);

  // The handlers are unguarded: check the token yourself.
  const guard: express.RequestHandler = (req, res, next) => (req.headers['x-metrics-token'] === token ? next() : res.status(401).end());

  app.get('/metrics', guard, (req, res) => void metricsHandler(metrics)(req, res));
  app.get('/telemetry/stats', guard, (req, res) => statsHandler(store)(req, res));
}
```

### Scrape config for Prometheus

```yaml
scrape_configs:
  - job_name: spinajs
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/spinajs-token
    static_configs:
      - targets: ['api:8080']
```

## Related

- [Endpoint access](10-endpoint-access.md): the slots behind every route.
- [Request statistics](05-request-statistics.md), [Perf bridge](06-perf-bridge.md), [Health and readiness](08-health-and-readiness.md): what each endpoint reports.
- [`@spinajs/http` responses](../http/10-responses.md): the `Response` base class.
- [`@spinajs/http-swagger` named schemas](../http-swagger/04-named-schemas-and-schema-providers.md): how `@returns {Name}` resolves to a component.
