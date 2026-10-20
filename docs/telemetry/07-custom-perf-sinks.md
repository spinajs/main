# Custom perf sinks

Add a `PerfSink` to send `Perf` measurements to another destination, or to keep another in-memory view next to `PromMetricSink` and `InMemoryPerfSink`. This page covers what changes when `@spinajs/telemetry` is loaded; the `PerfSink` contract itself is in [`@spinajs/log` custom perf sinks](../log/16-custom-perf-sinks.md).

## How it works

1. Your class extends `PerfSink` and carries `@Singleton()` and `@Injectable(PerfSink)`. The import adds it to the `PerfSink` list.
2. `TelemetryBootstrapper` resolves the whole list with `DI.resolve(Array.ofType(PerfSink))`, so your sink is built in the same pass as the shipped ones.
3. It publishes every instance under its class name with `DI.register(sink).asValue(sink.constructor.name, true)`. `@Autoinject(YourSink)` in a controller then gets the instance `Perf` writes to.
4. It calls `Perf.refreshSinks()`. From the next measurement, `Perf` calls `collect()` and `onScopeEnd()` on your sink too.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Perf sink | `PerfSink` list (`Array.ofType(PerfSink)`); declare `@Singleton()`; published under its class name by `TelemetryBootstrapper` | `LogMetricSink` (`@spinajs/log`), `PromMetricSink`, `InMemoryPerfSink` | StatsD, OTLP, a database, a custom in-memory view | **Add**: `@Injectable(PerfSink)` on a subclass, imported before bootstrap. **Remove a shipped one**: `DI.unregister(PromMetricSink)` before `TelemetryBootstrapper` runs. **Late registration**: call `Perf.refreshSinks()` after registering |

### `PerfSink`: the ten slowest spans, served by your own endpoint

The sink keeps the slowest spans seen; a controller reads it through `@Autoinject`. The route reuses the telemetry access slots, so it is guarded like `/telemetry/perf`.

```ts sample
import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { PerfSink } from '@spinajs/log';
import type { IPerfMetric } from '@spinajs/log';
import { TelemetryAccess } from '@spinajs/telemetry';

export interface ISlowSpan {
  name: string;
  durationMs: number;
  requestId?: string;
}

@Singleton()
@Injectable(PerfSink)
export class SlowestSpansSink extends PerfSink {
  public readonly Slowest: ISlowSpan[] = [];

  public collect(metric: IPerfMetric): void {
    if (metric.kind !== 'span' || metric.durationMs === undefined) return;

    const floor = this.Slowest.length < 10 ? -1 : this.Slowest[this.Slowest.length - 1].durationMs;
    if (metric.durationMs <= floor) return;

    this.Slowest.push({ name: metric.name, durationMs: metric.durationMs, requestId: metric.requestId });
    this.Slowest.sort((a, b) => b.durationMs - a.durationMs);
    this.Slowest.length = Math.min(this.Slowest.length, 10);
  }
}

// config: telemetry.auth.policies.slowest = 'AccessPolicy', telemetry.auth.permissions.slowest = 'telemetry:read'
@BasePath('ops')
export class SlowSpansController extends BaseController {
  @Autoinject(SlowestSpansSink)
  protected Sink!: SlowestSpansSink;

  @Get('slowest-spans')
  @TelemetryAccess('slowest')
  public async slowest() {
    return new Ok({ spans: this.Sink.Slowest });
  }
}
```

### Replace the Prometheus sink

Drop `PromMetricSink` when another exporter owns the `perf_*` namespace, e.g. OTLP metrics. Unregister it in a module your app imports after `@spinajs/telemetry` and before bootstrap.

```ts sample
import { DI, Injectable, Singleton } from '@spinajs/di';
import { PerfSink } from '@spinajs/log';
import type { IPerfMetric } from '@spinajs/log';
import { PromMetricSink } from '@spinajs/telemetry';

/** Hands spans to an OTLP batch; the exporter that flushes it is out of scope here. */
@Singleton()
@Injectable(PerfSink)
export class OtlpPerfSink extends PerfSink {
  public readonly Batch: { name: string; durationMs: number; at: number }[] = [];

  public collect(metric: IPerfMetric): void {
    if (metric.kind === 'span' && this.Batch.length < 10_000) {
      this.Batch.push({ name: metric.name, durationMs: metric.durationMs ?? 0, at: metric.startedAt ?? Date.now() });
    }
  }
}

DI.unregister(PromMetricSink);
```

## Important behaviour

- Never resolve your sink directly (`DI.resolve(MySink)`) before `TelemetryBootstrapper` ran. The direct resolve caches the instance under its own name only, and the later list resolve can return it without adding it to the `PerfSink` list, so `Perf` never calls it. The bootstrapper's `override: true` publish fixes the cache for `@Autoinject`, not the list.
- A sink module imported after the first measurement is not called until `Perf.refreshSinks()`.
- `collect()` runs inline with the measured code; `Perf` swallows a throw, but slow work slows every measured call.
- Every sink gets every metric. Filter by `metric.name` or `metric.kind` inside `collect()`.

## Best practices

- Declare `@Singleton()`; `Perf.refreshSinks()` otherwise builds a new, empty instance.
- Bound every in-memory structure, as `InMemoryPerfSink` does with `telemetry.perf.maxNames`.
- Guard an endpoint that serves sink data with `@TelemetryAccess()` and a slot, so it shares the telemetry permission model.

## Patterns and antipatterns

```ts
// Don't: resolve the sink yourself at startup
const sink = DI.resolve(SlowestSpansSink); // may stay outside the PerfSink list

// Do: let TelemetryBootstrapper build it, then inject it
@Autoinject(SlowestSpansSink)
protected Sink!: SlowestSpansSink;
```

## Examples

### Count failed spans per name

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { PerfSink } from '@spinajs/log';
import type { IPerfMetric } from '@spinajs/log';

@Singleton()
@Injectable(PerfSink)
export class FailedSpansSink extends PerfSink {
  public readonly Failures = new Map<string, number>();

  public collect(metric: IPerfMetric): void {
    if (metric.kind === 'span' && metric.error !== undefined) {
      this.Failures.set(metric.name, (this.Failures.get(metric.name) ?? 0) + 1);
    }
  }
}
```

## Related

- [Perf bridge](06-perf-bridge.md): the two sinks this package ships.
- [Custom access policies](11-custom-access-policies.md): `@TelemetryAccess()` on your own routes.
- [`@spinajs/log` custom perf sinks](../log/16-custom-perf-sinks.md): the `PerfSink` contract, `IPerfMetric` and `IPerfRollup`.
- [`@spinajs/di` multiple implementations](../di/06-multiple-implementations.md): how `Array.ofType()` lists resolve.
