# Registry access

`Metrics.getRegistry()` returns the private prom-client `Registry` behind the service. Use it for what `defineMetrics()` does not cover: metrics computed at scrape time, prom-client options `MetricDef` lacks, default labels, JSON output and resets. Everything you register on it renders on `GET /metrics` like the declared metrics.

## How it works

1. `DI.resolve(Metrics).getRegistry()` returns the same `Registry` object `defineMetrics()`, `collectDefault()` and `render()` use.
2. You create a prom-client metric with `registers: [registry]`, or call `registry.registerMetric(metric)`.
3. On scrape, `render()` calls `registry.metrics()`, which runs every metric's `collect` callback, then formats all metrics.

The return type is the re-exported `Registry` type. To construct metrics or call static helpers (`Registry.merge`, `linearBuckets`), add `prom-client` to your package's dependencies at the same major version (`^14.2.0`).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| The private `Registry` | No DI token; owned by the `Metrics` singleton, one per instance | `new client.Registry()` in the `Metrics` constructor | A registry you assign to `this.registry` in a `Metrics` subclass | Register metrics on `getRegistry()`; to swap the registry itself, see [Custom metrics service](03-custom-metrics-service.md) |

What you can do through the registry:

| Need | prom-client API on `getRegistry()` |
| --- | --- |
| A value read at scrape time (queue depth, cache size) | `new Gauge({ ..., registers: [registry], collect() { this.set(...) } })` |
| Summary sliding window | `new Summary({ ..., maxAgeSeconds, ageBuckets, registers: [registry] })` |
| Cluster aggregation hint | `aggregator: 'sum' \| 'max' \| ...` on any metric |
| Labels on every metric (service, region) | `registry.setDefaultLabels({ ... })` |
| Machine-readable snapshot | `await registry.getMetricsAsJSON()` |
| Zero every value between tests | `registry.resetMetrics()` |
| Look up or drop one metric | `registry.getSingleMetric(name)`, `registry.removeSingleMetric(name)` |

## Important behaviour

- **`collect` runs on every scrape.** A slow or throwing `collect` slows or fails the whole `render()`. Keep it to an in-memory read.
- **Names still collide.** A metric you register with a name `defineMetrics()` later builds is removed by that call. A metric you register over an existing name throws `A metric with the name <name> has already been registered.`
- **Default labels apply to every metric of the registry,** including the `orm_*`, `socket_*`, `http_*` and `process_*` sets, from the next render on.
- **`resetMetrics()` zeroes values but keeps definitions,** so maps returned by `defineMetrics()` stay valid.
- **The registry dies with the singleton.** After `DI.clearCache()`, metrics you registered on the old registry are gone; register them again on the new one.

## Best practices

- Register scrape-time metrics once per `Metrics` instance, with the same `WeakMap<Metrics, ...>` guard libraries use for `defineMetrics()`.
- Prefer `defineMetrics()` when a `MetricDef` can describe the metric; use the registry for the rest.
- Put the same prefix on registry-built metrics as on your declared set, so one package owns one prefix.

## Patterns and antipatterns

```ts
// Don't: polls and sets the gauge on a timer; the value is stale between ticks and the timer outlives tests
setInterval(() => (map['queue_depth'] as Gauge<string>).set(queue.length), 5000);

// Do: let the scrape read the value
new Gauge({ name: 'jobs_queue_depth', help: 'Jobs waiting', registers: [metrics.getRegistry()], collect() { this.set(queue.length); } });
```

## Examples

### Report queue depth at scrape time

```ts sample
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';
import { Gauge } from 'prom-client';

const pending: string[] = ['invoice-17', 'invoice-18'];
const REGISTERED = new WeakSet<Metrics>();

export function registerQueueMetrics(): void {
  const metrics = DI.get(Metrics) ?? DI.resolve(Metrics);
  if (REGISTERED.has(metrics)) return;

  new Gauge({
    name: 'jobs_queue_depth',
    help: 'Jobs waiting in the invoice queue',
    registers: [metrics.getRegistry()],
    collect() {
      this.set(pending.length);
    },
  });

  REGISTERED.add(metrics);
}

registerQueueMetrics();
DI.resolve(Metrics).render().then((text) => console.log(text));
// # HELP jobs_queue_depth Jobs waiting in the invoice queue
// # TYPE jobs_queue_depth gauge
// jobs_queue_depth 2
```

### Label every metric with the region

```ts sample
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';

DI.resolve(Metrics).getRegistry().setDefaultLabels({ region: process.env.AWS_REGION ?? 'eu-central-1' });
// orm_pool_size{connection="default",region="eu-central-1"} 4
```

### Merge prom-client's global registry

Some libraries write to prom-client's global `register`. Render both without a custom service:

```ts sample
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';
import { Registry, register as globalRegistry } from 'prom-client';

export async function renderAll(): Promise<string> {
  const metrics = DI.resolve(Metrics);
  return Registry.merge([metrics.getRegistry(), globalRegistry]).metrics();
}

renderAll().then((text) => console.log(text));
```

`Registry.merge()` throws on a name present in both. To make `GET /metrics` use the merged output, override `render()` in a subclass; see [Custom metrics service](03-custom-metrics-service.md#expose-metrics-from-a-third-party-library-that-uses-the-global-registry).

### Read metrics as JSON for an admin page

```ts sample
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';

export async function poolSnapshot(): Promise<Array<{ name: string; values: unknown[] }>> {
  const all = await DI.resolve(Metrics).getRegistry().getMetricsAsJSON();
  return all.filter((m) => m.name.startsWith('orm_pool_')).map((m) => ({ name: m.name, values: m.values }));
}

poolSnapshot().then((rows) => console.log(rows));
```

## Related

- [Metrics service](01-metrics-service.md): the owner of this registry.
- [Metric definitions](02-metric-definitions.md): the declarative path, preferred when it fits.
- [Custom metrics service](03-custom-metrics-service.md): replacing the registry or overriding `render()`.
- [prom-client](https://github.com/siimon/prom-client): the full `Registry` and metric API.
