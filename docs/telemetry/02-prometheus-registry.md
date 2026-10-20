# Prometheus registry

`Metrics` is the one place every SpinaJS metric lives: a `@Singleton()` over a private prom-client `Registry`. Declare your own metrics on it with `defineMetrics()`, and they appear on `GET /metrics` next to the built-in series.

`Metrics` is defined in `@spinajs/telemetry-common` and re-exported by `@spinajs/telemetry`, so both imports give the same class and the same singleton.

## How it works

1. The first `DI.resolve(Metrics)` builds the singleton. Its constructor creates `new client.Registry()`, never prom-client's global default registry.
2. `defineMetrics(prefix, defs)` builds one prom-client metric per `MetricDef`, named `${prefix}_${def.name}`, registered on that private registry. A name that is already registered is removed first and recreated.
3. It returns a `MetricMap`: the metrics keyed by the unprefixed `def.name`. Narrow each entry to `Counter`, `Gauge`, `Histogram` or `Summary` before you call it.
4. `TelemetryBootstrapper` calls `collectDefault()`, which adds prom-client's process, heap, CPU and event-loop metrics to the same registry.
5. `MetricsController` (`GET /metrics`) returns a `PrometheusResponse`, which awaits `render()` and sets `contentType()` as the `Content-Type`.

## API

| Member | Returns | Effect |
| --- | --- | --- |
| `defineMetrics(prefix, defs)` | `MetricMap` | Builds, or rebuilds, the metrics in `defs` under `${prefix}_` |
| `collectDefault()` | `void` | Registers prom-client default metrics on the private registry |
| `render()` | `Promise<string>` | Prometheus exposition text of the whole registry |
| `contentType()` | `string` | The registry's exposition `Content-Type` |
| `getRegistry()` | `Registry` | The raw prom-client registry |

| Type | Shape |
| --- | --- |
| `MetricDef` | `{ name, help, type, labelNames?, buckets?, percentiles? }` |
| `MetricType` | `'counter' \| 'gauge' \| 'histogram' \| 'summary'` |
| `AnyMetric` | `Counter<string> \| Gauge<string> \| Histogram<string> \| Summary<string>` |
| `MetricMap<T>` | `Record<string, T>` |
| `Counter`, `Gauge`, `Histogram`, `Summary`, `Registry` | prom-client types, re-exported as types |

- `buckets` applies to `histogram` only; without it the histogram uses `linearBuckets(1, 1, 10)` (1 to 10).
- `percentiles` applies to `summary` only; without it prom-client defaults apply.
- An unknown `type` throws `Error("unknown metric type '<type>' for metric '<name>'")`.

## Metrics reference

Everything on the registry renders on `GET /metrics`:

| Series | Type | Labels | Emitted by |
| --- | --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status` | `TelemetryMiddleware`, see [HTTP request metrics](03-http-request-metrics.md) |
| `http_request_duration_ms` | histogram | `method`, `route`, `status` | `TelemetryMiddleware` |
| `http_requests_in_flight` | gauge | none | `TelemetryMiddleware` |
| `perf_span_duration_ms` | histogram | `name` | `PromMetricSink`, see [Perf bridge](06-perf-bridge.md) |
| `perf_events_total` | counter | `name` | `PromMetricSink` |
| `perf_scope_total_ms` | histogram | `name` | `PromMetricSink` |
| `process_*`, `nodejs_*` | various | various | `collectDefault()`, unless `telemetry.collectDefaultMetrics` is `false` |
| `orm_*` | gauges, histogram | `connection` | [`@spinajs/orm`](../orm/13-observability-and-resilience.md) |
| `socket_*` | counters, histogram, gauge | `command`, `code` | [`@spinajs/http-socket`](../http-socket/16-observability.md) |

The `http_` prefix follows `telemetry.prefix`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Metric registry | `Metrics`, `@Singleton()`, registered by `@Injectable()` at import of `@spinajs/telemetry-common`; consumers use `DI.get(Metrics) ?? DI.resolve(Metrics)` | `Metrics` (private prom-client registry) | none shipped | Subclass and `DI.register(MyMetrics).as(Metrics)` before anything resolves `Metrics`: the ORM, the socket server, the middleware and the perf sink all resolve it lazily, on first use |

### `Metrics`: share the process-wide default registry

Replace `Metrics` when another library in the process already exports to prom-client's global registry and you want one scrape for both. Override the constructor's registry choice and keep the rest.

```ts sample
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry';
import * as client from 'prom-client';

/** Puts every SpinaJS metric on prom-client's global registry, next to a third-party library's metrics. */
export class GlobalRegistryMetrics extends Metrics {
  constructor() {
    super();
    this.registry = client.register;
  }
}

// After '@spinajs/telemetry' is imported, before the first DI.resolve(Metrics).
DI.register(GlobalRegistryMetrics).as(Metrics);
```

A replacement shares state with every other user of the global registry: a second app in the same process, or tests that rebuild the container, see each other's metrics.

## Important behaviour

- `defineMetrics()` replaces a metric with the same full name. The new object starts at zero, and earlier references to the old object keep counting into a metric nobody renders. Call it once per metric set.
- `render()` is async in prom-client 14; await it.
- `DI.clearCache()` drops the singleton, so the next resolve builds a fresh, empty registry. Keep metric references keyed by the `Metrics` instance, not in module-level variables.
- Nothing caps label values. Every distinct label value is a new series in the registry and in Prometheus.

## Best practices

- Build each metric set once per `Metrics` instance; `@spinajs/orm` and `@spinajs/http-socket` keep a `WeakMap<Metrics, MetricMap>` for that.
- Resolve with `DI.get(Metrics) ?? DI.resolve(Metrics)` and wrap the publish in `try`/`catch`, so a metrics failure never fails business code.
- Keep label values to fixed vocabularies: never ids, emails or raw URLs.
- Name units in the metric name (`_ms`, `_seconds`, `_total`).

## Patterns and antipatterns

```ts
// Don't: define on every call; each call resets the counter to zero
export function onOrder(channel: string) {
  const { created_total } = metrics.defineMetrics('orders', [ORDER_CREATED]);
  (created_total as Counter<string>).inc({ channel });
}

// Do: define once per Metrics instance, then reuse
const DEFINED = new WeakMap<Metrics, MetricMap>();
function orderMetrics(metrics: Metrics): MetricMap {
  let map = DEFINED.get(metrics);
  if (!map) DEFINED.set(metrics, (map = metrics.defineMetrics('orders', [ORDER_CREATED])));
  return map;
}
```

## Examples

### Track order volume and value

```ts sample
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry';
import type { Counter, Gauge, Histogram, MetricMap } from '@spinajs/telemetry';

const DEFINED = new WeakMap<Metrics, MetricMap>();

function orderMetrics(): MetricMap | null {
  try {
    const metrics = DI.get(Metrics) ?? DI.resolve(Metrics);
    let map = DEFINED.get(metrics);
    if (!map) {
      map = metrics.defineMetrics('orders', [
        { name: 'created_total', help: 'Orders created', type: 'counter', labelNames: ['channel'] },
        { name: 'value_eur', help: 'Order value in EUR', type: 'histogram', buckets: [10, 50, 100, 500, 1000] },
        { name: 'pending', help: 'Orders awaiting payment', type: 'gauge' },
      ]);
      DEFINED.set(metrics, map);
    }
    return map;
  } catch {
    return null;
  }
}

export function recordOrder(channel: 'web' | 'mobile', valueEur: number, pending: number): void {
  const map = orderMetrics();
  if (!map) return;

  (map['created_total'] as Counter<string>).inc({ channel });
  (map['value_eur'] as Histogram<string>).observe(valueEur);
  (map['pending'] as Gauge<string>).set(pending);
}
```

### Read one series without the HTTP endpoint

```ts sample
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry';

export async function inFlightRequests(): Promise<number> {
  const metrics = DI.get(Metrics) ?? DI.resolve(Metrics);
  const line = (await metrics.render()).split('\n').find((l) => l.startsWith('http_requests_in_flight '));
  return line ? Number(line.split(' ')[1]) : 0;
}
```

## Related

- [HTTP request metrics](03-http-request-metrics.md): the `http_*` series.
- [Perf bridge](06-perf-bridge.md): the `perf_*` series.
- [Endpoints and OpenAPI](09-endpoints-and-openapi.md): `GET /metrics` and `metricsHandler()`.
- [`@spinajs/orm` observability](../orm/13-observability-and-resilience.md): the `orm_*` pool metrics on the same registry.
