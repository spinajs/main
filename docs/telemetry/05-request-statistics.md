# Request statistics

`TelemetryStore` keeps JSON-readable request statistics next to the Prometheus series: lifetime counters with an Apdex score, a rolling timeline, and a bounded per-route breakdown. `GET /telemetry/stats`, `/telemetry/timeline` and `/telemetry/routes` serve them.

## How it works

1. `TelemetryStore` is a `@Singleton()` `AsyncService`. Its `resolve()` rebuilds `RequestStats`, `Timeline` and `RouteStats` from configuration and reads `telemetry.routes.enabled`.
2. `TelemetryMiddleware` calls `store.record(method, route, statusCode, durationMs)` once per finished response. It is the only writer.
3. `record()` updates three aggregates:
   1. `RequestStats.countRequest()` and `countResponse(statusCode, durationMs)` on the lifetime stats;
   2. `Timeline.record(statusCode, durationMs, Date.now())`, which opens the current bucket and expires buckets older than `length`;
   3. `RouteStats.record(method, route, statusCode, durationMs)` when `RoutesEnabled` is not `false`.
4. `TelemetryController` reads the store:
   - `GET /telemetry/stats` calls `RequestStats.updateRates(Date.now() - store.StartedAt)`, then returns `{ all, timeline }`;
   - `GET /telemetry/timeline?buckets=N` returns the buckets in ascending key order, each with its time window;
   - `GET /telemetry/routes` returns `RouteStats.toJSON()`.

The store exists because a `ServerMiddleware` is not a singleton: the instance express mounts is not the one a controller would get from `@Autoinject`.

### `RequestStats`

| Field (snapshot key) | Meaning |
| --- | --- |
| `requests`, `responses` | Counted requests and responses |
| `errors` | Responses with status 400 or above |
| `info`, `success`, `redirect`, `client_error`, `server_error` | Responses per status class (1xx to 5xx) |
| `total_time`, `max_time`, `min_time`, `avg_time` | Response times in ms |
| `apdex_satisfied`, `apdex_tolerated`, `apdex_score` | Apdex counters and score |
| `req_rate`, `err_rate` | Requests and errors per second over the last `updateRates()` window |

- Apdex score is `(satisfied + tolerated / 2) / responses`, `0` with no responses.
- A response is satisfied at or under `apdexThreshold` ms, tolerated up to 4x that. Any 4xx or 5xx response counts as frustrated, whatever its duration.
- `RequestStats` is pure: it reads no clock and no DI. `updateRates(elapsedMs)` takes the window in.

### `Timeline`

- A ring of `length` buckets, each `bucketMs` wide, keyed by `Math.floor(timestamp / bucketMs)`.
- Each bucket holds its own `RequestStats` with the store's Apdex threshold.
- `tick(now)` opens the bucket for `now` and deletes keys below `current - length + 1`. `record()` calls it.
- `toJSON()` returns `Record<string, IRequestStatsSnapshot>`, keyed by the bucket key.

### `RouteStats`

- A `method + ' ' + route → RequestStats` map capped at `maxEntries`.
- Past the cap, known routes keep counting, new ones are dropped, and `truncated` becomes `true`.
- `toJSON()` returns `{ truncated, routes: [{ method, route, stats }] }`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `telemetry.apdexThresholdMs` | `number` | `25` | ms | Apdex satisfied threshold for all three aggregates |
| `telemetry.timeline.length` | `number` | `60` | positive integer | Buckets kept |
| `telemetry.timeline.bucketMs` | `number` | `60000` | ms | Bucket width |
| `telemetry.routes.enabled` | `boolean` | `true` | `true`, `false` | Record the per-route breakdown |
| `telemetry.routes.maxEntries` | `number` | `500` | positive integer | Cap on method+route keys |

```ts
export default {
  telemetry: {
    apdexThresholdMs: 100,
    timeline: { length: 24, bucketMs: 3_600_000 }, // one day of hourly buckets
    routes: { maxEntries: 200 },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Statistics store | `TelemetryStore`, `@Singleton()` `AsyncService`, registered by `@Injectable()` at import; injected with `@Autoinject(TelemetryStore)` into `TelemetryMiddleware` and `TelemetryController` | `TelemetryStore` | your subclass | Subclass, override `record()` (call `super.record()`) or `resolve()`; `DI.register(MyStore).as(TelemetryStore)` before the first request and before `HttpServer` resolves |
| Aggregates | plain classes, no DI; created by `TelemetryStore.resolve()` | `RequestStats`, `Timeline`, `RouteStats` | your subclasses | Assign your own instances to `RequestStats`, `Timeline` or `RouteStats` in an overridden `resolve()`, after `super.resolve()` |

### `TelemetryStore`: keep the last slow requests

Replace the store when you need another view of the same stream. This one keeps the 50 most recent requests over one second.

```ts sample
import { DI, Injectable, Singleton } from '@spinajs/di';
import { TelemetryStore } from '@spinajs/telemetry';

export interface ISlowRequest {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  at: number;
}

@Singleton()
@Injectable()
export class SlowRequestStore extends TelemetryStore {
  public readonly SlowRequests: ISlowRequest[] = [];

  public record(method: string, route: string, statusCode: number, durationMs: number): void {
    super.record(method, route, statusCode, durationMs);

    if (durationMs > 1000) {
      this.SlowRequests.push({ method, route, status: statusCode, durationMs, at: Date.now() });
      if (this.SlowRequests.length > 50) this.SlowRequests.shift();
    }
  }
}

DI.register(SlowRequestStore).as(TelemetryStore);

export async function slowRequests(): Promise<ISlowRequest[]> {
  const store = await DI.resolve(TelemetryStore);
  return store instanceof SlowRequestStore ? [...store.SlowRequests] : [];
}
```

### `TelemetryStore`: a finer timeline for one deployment

```ts sample
import { DI, Injectable, Singleton } from '@spinajs/di';
import { Timeline, TelemetryStore } from '@spinajs/telemetry';

/** Ten-second buckets over the last ten minutes, whatever the configuration says. */
@Singleton()
@Injectable()
export class CanaryStore extends TelemetryStore {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Timeline = new Timeline(60, 10_000, this.ApdexThresholdMs);
  }
}

DI.register(CanaryStore).as(TelemetryStore);
```

## Important behaviour

- `req_rate` and `err_rate` are computed by `GET /telemetry/stats` only, over the whole lifetime since `StartedAt`, and stored on the shared `RequestStats`. `statsHandler()` returns whatever the last `/stats` call left, `0` before the first one. Timeline buckets and route entries always report `0`.
- `min_time` keeps the first non-zero minimum: a response of exactly `0` ms leaves it at `0`, and the next response overwrites that `0`.
- The timeline expires buckets only when a response is recorded. After an idle period, `/telemetry/timeline` still returns buckets older than `length` until the next request.
- The aggregates live in process memory. They reset on restart and are per process; behind a load balancer each replica reports its own numbers.
- `GET /telemetry/timeline` rejects a `buckets` value that is not a positive integer, empty string included, with 400 `buckets must be a positive integer`. An absent `buckets` returns every bucket.
- `/telemetry/routes` has no percentiles; query them from the `route`-labelled histogram.

## Best practices

- Set `telemetry.apdexThresholdMs` to your target response time; the default `25` ms marks most real API calls as tolerated or frustrated.
- Watch `truncated` in `/telemetry/routes`: `true` means unmatched paths filled the map. Collapse them with a [custom route label](04-customizing-the-request-middleware.md).
- Use Prometheus for history and alerting; the JSON views are for dashboards and quick checks of one replica.

## Patterns and antipatterns

```ts
// Don't: write to the store from your own middleware; every response is counted twice
store.record(req.method, req.path, res.statusCode, ms);

// Do: let TelemetryMiddleware write, and extend record() in a store subclass
public record(method: string, route: string, statusCode: number, durationMs: number): void {
  super.record(method, route, statusCode, durationMs);
}
```

## Examples

### Compute Apdex for a batch of recorded timings

```ts sample
import { RequestStats } from '@spinajs/telemetry';

export function apdexOf(samples: { status: number; ms: number }[], thresholdMs = 100): number {
  const stats = new RequestStats(thresholdMs);
  for (const s of samples) {
    stats.countRequest();
    stats.countResponse(s.status, s.ms);
  }
  return stats.apdex();
}
```

### Read the last five timeline buckets

```bash
curl -H "x-metrics-token: $METRICS_TOKEN" "http://localhost:8080/telemetry/timeline?buckets=5"
```

```jsonc
{
  "bucketMs": 60000,
  "length": 60,
  "buckets": [
    { "key": 29014823, "from": 1740889380000, "to": 1740889440000, "stats": { "requests": 42, "avg_time": 33.1, "apdex_score": 0.95 /* ... */ } }
  ]
}
```

## Related

- [HTTP request metrics](03-http-request-metrics.md): the middleware that writes the store.
- [Endpoints and OpenAPI](09-endpoints-and-openapi.md): response schemas and `statsHandler()`.
- [Endpoint access](10-endpoint-access.md): who may read the three endpoints.
