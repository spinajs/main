# Custom metrics service

Every consumer in the monorepo resolves `Metrics` by its DI key, so one registration changes where all metrics go and how they render. Subclass `Metrics` to add app-wide labels, guard the metric names, or change the output; replace it outright only when you need a different backing store.

## How it works

1. **Default registration.** Importing `@spinajs/telemetry-common` registers `Metrics` under the key `'Metrics'` in the root container.
2. **Your registration.** `@Injectable(Metrics)` on your class, or `DI.register(MyMetrics).as(Metrics)`, appends it to the list under `'Metrics'`. A single resolve takes the last entry, so yours wins.
3. **Lifetime.** A subclass inherits the `@Singleton()` descriptor of `Metrics`; it needs no lifetime decorator of its own. `DI.resolve(Metrics)`, `DI.resolve(MyMetrics)` and `DI.get(Metrics)` return the same instance.
4. **Use.** `TelemetryBootstrapper`, `MetricsController`, the telemetry middleware, `PromMetricSink`, `ormMetrics()` and `socketMetrics()` all get your instance; `GET /metrics` renders your `render()` with your `contentType()`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Metrics` | `Metrics` (`'Metrics'`), singleton, root container | `Metrics` | None shipped | Subclass and register `.as(Metrics)`, or register any class with the same public members `.as(Metrics)` |

### Overridable members

| Member | Called by | Override to |
| --- | --- | --- |
| `constructor()` | DI, once per singleton | Configure `this.registry` (default labels), or set `this.registry` to a registry you build |
| `defineMetrics(prefix, defs)` | Every package that publishes metrics | Enforce a naming rule, add buckets, log definitions; call `super.defineMetrics()` to keep the build |
| `collectDefault()` | `TelemetryBootstrapper` when `telemetry.collectDefaultMetrics` is `true` | Make it idempotent, pass prom-client options (`prefix`, `gcDurationBuckets`) |
| `render()` | `GET /metrics`, your scrape handler | Merge other registries, filter output |
| `contentType()` | `GET /metrics`, your scrape handler | Match a changed `render()` format |
| `getRegistry()` | Code that needs the raw registry | Return a merged or wrapped registry |
| `registry` (protected field) | All of the above | Read or replace in a subclass |

### Metrics: custom implementation

Register the replacement **at import time, before anything resolves `Metrics`**. Put it in a module the app imports before bootstrap: `TelemetryBootstrapper` resolves `Metrics` while bootstrappers run.

A registration made after the first resolve splits the app in two: `DI.get(Metrics)` keeps returning the old instance until something calls `DI.resolve(Metrics)`, which builds your class with a new, empty registry. Metric sets already defined stay in the old registry and stop rendering.

Register in the root container. A `child.register(MyMetrics).as(Metrics)` is invisible to `ormMetrics()`, `socketMetrics()` and the telemetry middleware, which read the root `DI`.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { Metrics, MetricDef, MetricMap } from '@spinajs/telemetry-common';

// One registry for the whole app, labelled with the service and the host,
// with collectDefault() safe to call twice and prefixes owned by one package each.
@Injectable(Metrics)
export class AppMetrics extends Metrics {
  protected defaultsCollected = false;
  protected prefixOwners = new Map<string, string>();

  constructor() {
    super();
    this.registry.setDefaultLabels({
      service: process.env.SERVICE_NAME ?? 'billing-api',
      instance: process.env.HOSTNAME ?? 'local',
    });
  }

  public defineMetrics(prefix: string, defs: MetricDef[]): MetricMap {
    const names = defs.map((d) => d.name).sort().join(',');
    const owner = this.prefixOwners.get(prefix);

    if (owner !== undefined && owner !== names) {
      throw new Error(`metric prefix '${prefix}' is already used by another metric set (${owner})`);
    }

    this.prefixOwners.set(prefix, names);
    return super.defineMetrics(prefix, defs);
  }

  public collectDefault(): void {
    if (this.defaultsCollected) return;
    super.collectDefault();
    this.defaultsCollected = true;
  }
}

const metrics = DI.resolve(Metrics);
metrics.collectDefault();
metrics.collectDefault();

metrics.defineMetrics('billing', [{ name: 'invoices_total', help: 'Invoices issued', type: 'counter' }]);

console.log(metrics instanceof AppMetrics, DI.get(Metrics) === metrics);
// true true
```

`defineMetrics()` with the same definitions again still passes the guard, so the rebuild used in tests keeps working.

### Extending instead of replacing

Override only what you change and call `super` for the rest. The default `defineMetrics()` keeps its rebuild-on-duplicate rule, the private registry and the metric construction. Every consumer receives your subclass through the `Metrics` type, so new public methods are visible only to code that resolves your class by its own name.

## Important behaviour

- **The last registration wins.** Two `@Injectable(Metrics)` subclasses in one app: import order decides which one every consumer gets.
- **Late registration splits the registry.** See the warning above; it is the most common failure when replacing `Metrics`.
- **`DI.clearCache()` rebuilds your class.** The next resolve creates a new instance of your subclass with a fresh registry; state in fields (eg. `defaultsCollected`) resets with it.
- **Consumers depend on the public members.** A class that is not a subclass must implement `defineMetrics()`, `collectDefault()`, `render()`, `contentType()` and `getRegistry()` with the same signatures, because packages call them through the `Metrics` type.

## Best practices

- Prefer a subclass to a fresh class: the default `defineMetrics()` is what `@spinajs/orm`, `@spinajs/http-socket` and `@spinajs/telemetry` are written against.
- Set default labels in the constructor, before any package defines metrics; prom-client applies them at render time to every metric of the registry.
- Keep `render()` and `contentType()` consistent: Prometheus parses the body by the content type.

## Patterns and antipatterns

```ts
// Don't: registered inside a bootstrapper, after TelemetryBootstrapper may have resolved Metrics
class LateBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(AppMetrics).as(Metrics);
  }
}

// Do: register at module load, imported before the app bootstraps
@Injectable(Metrics)
export class AppMetrics extends Metrics {}
```

## Examples

### Expose metrics from a third-party library that uses the global registry

A dependency calls prom-client's global `register`. Merge it into the scrape output without moving any metric.

```ts sample
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';
import { Registry, register as globalRegistry } from 'prom-client';

export class MergedMetrics extends Metrics {
  public async render(): Promise<string> {
    return Registry.merge([this.registry, globalRegistry]).metrics();
  }
}

DI.register(MergedMetrics).as(Metrics);

const metrics = DI.resolve(Metrics);
metrics.render().then((text) => console.log(text.length > 0));
```

`Registry.merge()` throws when both registries hold a metric with the same name, so keep `collectDefault()` on one side only.

### Replace the service in a test

Count what a unit under test defines, without rendering.

```ts sample
import { DI } from '@spinajs/di';
import { Metrics, MetricDef, MetricMap } from '@spinajs/telemetry-common';

class RecordingMetrics extends Metrics {
  public readonly defined: string[] = [];

  public defineMetrics(prefix: string, defs: MetricDef[]): MetricMap {
    this.defined.push(...defs.map((d) => `${prefix}_${d.name}`));
    return super.defineMetrics(prefix, defs);
  }
}

DI.clearCache();
DI.register(RecordingMetrics).as(Metrics);

DI.resolve(Metrics).defineMetrics('export', [{ name: 'rows_total', help: 'Exported rows', type: 'counter' }]);

const recorder = DI.resolve(RecordingMetrics);
console.log(recorder.defined);
// [ 'export_rows_total' ]

DI.unregister(RecordingMetrics);
DI.uncache(Metrics);
```

## Related

- [Metrics service](01-metrics-service.md): the default behaviour you extend.
- [Registry access](04-registry-access.md): changing the registry without replacing the service.
- [Registering services](../di/01-registering-services.md#replacing-a-registered-service): DI's "last registration wins" and timing rules.
- [Descriptor inheritance](../di/14-descriptor-inheritance.md): why a subclass keeps the singleton lifetime.
- [`@spinajs/telemetry`](../telemetry/README.md): `MetricsController` and `TelemetryBootstrapper`, the main consumers.
