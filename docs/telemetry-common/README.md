# `@spinajs/telemetry-common`

The Prometheus metric layer every SpinaJS package can write to: one `Metrics` DI singleton over a private prom-client registry, a declarative `defineMetrics()` factory, and the metric types. It depends on `@spinajs/di` and `prom-client` only, so a library (`@spinajs/orm`, `@spinajs/http-socket`) can publish metrics without pulling in the HTTP stack.

It does **not** serve an endpoint. `GET /metrics`, the HTTP request metrics, the perf bridge and the `telemetry.*` config live in [`@spinajs/telemetry`](../telemetry/README.md), which re-exports everything from this package and renders the same `Metrics` singleton. It reads no configuration and registers nothing in prom-client's global default registry.

## Install

```sh
npm install @spinajs/telemetry-common
```

Importing the package registers `Metrics` in the root DI container (`@Injectable()` runs at import time). Nothing else needs wiring.

## Features

| Feature | What it does |
| --- | --- |
| [Metrics service](01-metrics-service.md) | The `Metrics` singleton: its private registry, `render()`, `contentType()`, `collectDefault()`, and serving it without `@spinajs/telemetry` |
| [Metric definitions](02-metric-definitions.md) | `defineMetrics(prefix, defs)`, `MetricDef`, `MetricType`, `MetricMap`, the re-exported prom-client types, and the "metric set" pattern libraries use |
| [Custom metrics service](03-custom-metrics-service.md) | Replace or extend `Metrics`: subclass it, register it as `Metrics`, and when to register |
| [Registry access](04-registry-access.md) | `getRegistry()`: the raw prom-client registry for metrics `MetricDef` cannot describe, default labels and merged output |

## Extension points at a glance

| Extension point | How you plug in | Page |
| --- | --- | --- |
| `Metrics` service | `DI.register(MyMetrics).as(Metrics)` before the first resolve | [Custom metrics service](03-custom-metrics-service.md#metrics-custom-implementation) |
| `Metrics` methods | Subclass, override `defineMetrics()`, `render()`, `contentType()` or `collectDefault()` | [Custom metrics service](03-custom-metrics-service.md#extending-instead-of-replacing) |
| Your package's metric set | `defineMetrics(prefix, defs)` once per `Metrics` instance | [Metric definitions](02-metric-definitions.md#publish-metrics-from-a-library) |
| prom-client registry | `getRegistry()`, then any prom-client API | [Registry access](04-registry-access.md#examples) |

## Quick start

Count invoices by outcome and print the Prometheus text.

```ts sample
import { DI } from '@spinajs/di';
import { Metrics, Counter } from '@spinajs/telemetry-common';

const metrics = DI.resolve(Metrics);

const billing = metrics.defineMetrics('billing', [
  { name: 'invoices_total', help: 'Invoices issued, by outcome', type: 'counter', labelNames: ['outcome'] },
]);

const invoices = billing['invoices_total'] as Counter<string>;
invoices.inc({ outcome: 'paid' });

metrics.render().then((text) => console.log(text));
// # HELP billing_invoices_total Invoices issued, by outcome
// # TYPE billing_invoices_total counter
// billing_invoices_total{outcome="paid"} 1
```

## Who writes into `Metrics`

| Package | Prefix | Metrics |
| --- | --- | --- |
| `@spinajs/telemetry` | `http` (`telemetry.prefix`) | `http_requests_total`, `http_request_duration_ms`, `http_requests_in_flight` |
| `@spinajs/telemetry` | `perf` | `perf_span_duration_ms`, `perf_events_total`, `perf_scope_total_ms` |
| `@spinajs/telemetry` | none (prom-client) | `process_*`, `nodejs_*` through `collectDefault()`, when `telemetry.collectDefaultMetrics` is `true` |
| `@spinajs/orm` | `orm` | Pool gauges, acquire histogram, connection state; see [ORM observability](../orm/13-observability-and-resilience.md) |
| `@spinajs/http-socket` | `socket` | Commands, durations, connections, streams; see [Socket observability](../http-socket/16-observability.md) |

Pick a prefix no other package uses: `defineMetrics()` replaces a metric with the same full name.

## Related packages

- [`@spinajs/telemetry`](../telemetry/README.md): serves `GET /metrics` from this singleton, defines the HTTP and perf metrics, calls `collectDefault()` at boot.
- [`@spinajs/di`](../di/README.md): `Metrics` is a DI singleton; see [lifetimes](../di/04-lifetimes.md) and [registering services](../di/01-registering-services.md#replacing-a-registered-service).
- [`@spinajs/orm`](../orm/13-observability-and-resilience.md) and [`@spinajs/http-socket`](../http-socket/16-observability.md): libraries that publish their metrics through this package.
- [`@spinajs/log-common`](../log-common/09-perf-instrumentation.md): the `Perf` facade, whose `PromMetricSink` in `@spinajs/telemetry` writes into `Metrics`.
- [prom-client](https://github.com/siimon/prom-client) 14: the metric implementation underneath.
