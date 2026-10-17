# HTTP request metrics

`TelemetryMiddleware` times every HTTP request and records a counter, a duration histogram and an in-flight gauge on the `Metrics` registry. It also feeds `TelemetryStore`, which backs the JSON statistics endpoints. It runs with no code once the package is imported.

## How it works

1. `HttpServer` resolves the `ServerMiddleware` list, which contains `TelemetryMiddleware` (`Order = 2`, next to `RequestId` and `AccessLog`, after request storage).
2. For each request, the handler from `before()`:
   1. calls `ensureMetrics()`. The first call resolves `Metrics` and defines `<prefix>_requests_total`, `<prefix>_request_duration_ms` and `<prefix>_requests_in_flight`;
   2. stores `process.hrtime.bigint()` in `req.storage`;
   3. increments the in-flight gauge;
   4. subscribes to the response `finish` and `close` events;
   5. calls `next()`, even when a step above threw.
3. On `finish`, `onFinish(req, res)`:
   1. computes the duration in ms from the stored start;
   2. reads the label set: `method`, `route` from `routeLabel(req)`, `status` from `res.statusCode`;
   3. decrements the in-flight gauge first;
   4. observes the histogram and increments the counter;
   5. calls `TelemetryStore.record(method, route, status, durationMs)`; see [Request statistics](05-request-statistics.md).
4. On `close` without a prior `finish` (the client aborted), it only decrements the gauge. Nothing else is recorded, because no response was sent.
5. `after()` returns `null`; express never reaches it for a matched route.

### Series

| Series | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `<prefix>_requests_total` | counter | `method`, `route`, `status` | Responses sent |
| `<prefix>_request_duration_ms` | histogram | `method`, `route`, `status` | Time from `before()` to `finish`, in ms |
| `<prefix>_requests_in_flight` | gauge | none | Requests started and not yet finished or aborted |

### Route label

`routeLabel(req)` returns, in order:

1. `req.route.path`, the path pattern the router matched (`/orders/:id`);
2. `req.storage.route`, when a string;
3. `req.path`, the raw path, when nothing matched;
4. `req.originalUrl`, else `'unknown'`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `telemetry.prefix` | `string` | `'http'` | a Prometheus name prefix | Prefix of the three series |
| `telemetry.buckets` | `number[]` | `DURATION_BUCKETS_MS` | ascending ms values | Histogram buckets |

`DURATION_BUCKETS_MS` is `[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]`. `DEFAULT_PREFIX` is `'http'`.

```ts
export default {
  telemetry: {
    prefix: 'api', // api_requests_total, api_request_duration_ms, api_requests_in_flight
    buckets: [5, 25, 100, 500, 2500],
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Request middleware | `ServerMiddleware` list, registered by `@Injectable(ServerMiddleware)` at import; a new instance per resolve, read once when `HttpServer` resolves | `TelemetryMiddleware` | your subclass | Override `routeLabel()`, `onFinish()` or `ensureMetrics()`; register the subclass and `DI.unregister(TelemetryMiddleware)`. See [Customizing the request middleware](04-customizing-the-request-middleware.md) |
| Statistics store | `TelemetryStore`, `@Singleton()`, injected with `@Autoinject(TelemetryStore)` | `TelemetryStore` | your subclass | See [Request statistics](05-request-statistics.md) |

## Important behaviour

- The label set is read on `finish`, not in `before()`: `req.route` exists only after the router matched, and handlers may change the status.
- Every step is inside `try`/`catch`. A failing metric or store logs a `warn` on the `telemetry` logger and never breaks the request.
- The gauge is balanced exactly once per request, whichever of `finish` and `close` fires first.
- Unmatched requests (404 scans) are labelled with their raw path. Each distinct path is a new Prometheus series; the histogram has no cap. Collapse them with a [custom route label](04-customizing-the-request-middleware.md).
- The unit is milliseconds. A dashboard built for the retired `@spinajs/metrics` package (other series names, seconds) shows nothing, or values 1000 times too large.

## Best practices

- Change the prefix and the buckets through configuration; a subclass for that registers a second middleware.
- Query percentiles from the histogram: `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_ms_bucket[5m])))`.
- Set buckets around your latency target: a 200 ms SLO needs bucket edges near 200.

## Patterns and antipatterns

```ts
// Don't: subclass with @Injectable(ServerMiddleware) only to change the prefix.
// Both middlewares run: http_* and api_* series, and doubled /telemetry/stats counts.
@Injectable(ServerMiddleware)
class ApiTelemetry extends TelemetryMiddleware {
  protected Prefix = 'api';
}

// Do
export default { telemetry: { prefix: 'api' } };
```

## Examples

### Alert on the error ratio of one route

```promql
sum(rate(http_requests_total{route="/orders/:id", status=~"5.."}[5m]))
  / sum(rate(http_requests_total{route="/orders/:id"}[5m])) > 0.05
```

### Count requests in a test without the HTTP endpoint

```ts sample
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry';

export async function servedCount(route: string): Promise<number> {
  const metrics = DI.get(Metrics) ?? DI.resolve(Metrics);
  const text = await metrics.render();

  return text
    .split('\n')
    .filter((line) => line.startsWith('http_requests_total{') && line.includes(`route="${route}"`))
    .reduce((sum, line) => sum + Number(line.split(' ').pop()), 0);
}
```

## Related

- [Customizing the request middleware](04-customizing-the-request-middleware.md): subclassing and replacing it.
- [Request statistics](05-request-statistics.md): what `TelemetryStore.record()` does with each response.
- [`@spinajs/http` server middlewares](../http/15-server-middlewares.md): the `ServerMiddleware` list and `Order`.
