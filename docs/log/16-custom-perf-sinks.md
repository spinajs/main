# Custom perf sinks

A perf sink receives every measurement `Perf` emits and, optionally, a rollup at the end of each request. Register one to export metrics to another system, or subclass the default `LogMetricSink` to change what it logs.

## How it works

1. `@Injectable(PerfSink)` adds the class to the `PerfSink` list when its module is imported.
2. On the first measurement, `Perf` resolves `DI.resolve(Array.ofType(PerfSink))` and memoizes the list.
3. Every span, counter and value calls `sink.collect(metric)` on each sink, in registration order, inside a `try`/`catch`.
4. `Perf.flushScope()` calls `sink.onScopeEnd?.(rollup)` on each sink, also guarded.

## Configuration

`PerfSink` has no config of its own. Read your keys with `@Config()` from `@spinajs/configuration`, as `LogMetricSink` reads `logger.perf.*`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Perf sink | `PerfSink` (abstract, a `SyncService`), list resolved with `Array.ofType(PerfSink)`; use `@Singleton()` | `LogMetricSink` | `PromMetricSink`, `InMemoryPerfSink` (`@spinajs/telemetry`) | **Add**: `@Injectable(PerfSink)` on a subclass. **Replace the log sink**: `DI.unregister(LogMetricSink)`, then register yours. **Extend**: subclass `LogMetricSink` and override `collect()` / `onScopeEnd()`. All before the first measurement, or call `Perf.refreshSinks()`. |

### `PerfSink` contract

| Member | Contract |
| --- | --- |
| `collect(metric)` | Abstract. Synchronous. Must not throw (it is guarded, but a throw skips the rest of your code). Keep it cheap: it runs inline with the measured code. |
| `onScopeEnd?(rollup)` | Optional. One call per request scope with `{ requestId, labels, totalMs, byName }`. |
| `IPerfMetric` | `{ name, kind: 'span' \| 'counter' \| 'value', durationMs?, value?, labels?, fields?, startedAt?, requestId?, error? }` |

### Custom sink: send spans and counters to StatsD

```ts sample
import { createSocket, Socket } from 'node:dgram';
import { Injectable, Singleton } from '@spinajs/di';
import { IPerfMetric, IPerfRollup, PerfSink } from '@spinajs/log';

@Singleton()
@Injectable(PerfSink)
export class StatsdPerfSink extends PerfSink {
  protected socket!: Socket;
  protected host = process.env.STATSD_HOST ?? '127.0.0.1';
  protected port = Number(process.env.STATSD_PORT ?? 8125);

  public resolve(): void {
    this.socket = createSocket('udp4');
    this.socket.unref();
    super.resolve();
  }

  public collect(metric: IPerfMetric): void {
    const tags = Object.entries(metric.labels ?? {})
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    const suffix = tags ? `|#${tags}` : '';

    if (metric.kind === 'span') {
      this.send(`${metric.name}:${(metric.durationMs ?? 0).toFixed(1)}|ms${suffix}`);
      if (metric.error !== undefined) {
        this.send(`${metric.name}.errors:1|c${suffix}`);
      }
    } else if (metric.kind === 'counter') {
      this.send(`${metric.name}:${metric.value ?? 1}|c${suffix}`);
    } else {
      this.send(`${metric.name}:${metric.value ?? 0}|g${suffix}`);
    }
  }

  public onScopeEnd(rollup: IPerfRollup): void {
    this.send(`request.total:${rollup.totalMs.toFixed(1)}|ms`);
  }

  public async dispose(): Promise<void> {
    this.socket?.close();
  }

  protected send(line: string): void {
    this.socket.send(line, this.port, this.host, () => undefined);
  }
}
```

Import the module before the first measurement; the sink list is memoized.

### Extending `LogMetricSink`: skip health-check spans

`LogMetricSink`'s formatting helpers are private; extend it by filtering what reaches `collect()` and `onScopeEnd()`.

```ts sample
import { DI, Injectable, Singleton } from '@spinajs/di';
import { IPerfMetric, IPerfRollup, LogMetricSink, PerfSink } from '@spinajs/log';

DI.unregister(LogMetricSink);

@Singleton()
@Injectable(PerfSink)
export class QuietLogMetricSink extends LogMetricSink {
  public collect(metric: IPerfMetric): void {
    if (metric.labels?.route === '/health') {
      return;
    }
    super.collect(metric);
  }

  public onScopeEnd(rollup: IPerfRollup): void {
    if (rollup.labels?.route === '/health' || Object.keys(rollup.byName).length === 0) {
      return;
    }
    super.onScopeEnd(rollup);
  }
}
```

## Important behaviour

- The sink list is resolved once. A sink imported after the first measurement is not called until `Perf.refreshSinks()`.
- Every registered sink receives every metric; there is no routing between sinks. Filter inside `collect()`.
- A sink without `@Singleton()` is still resolved only once per memoized list, but `Perf.refreshSinks()` then builds a new instance.
- `collect()` runs synchronously inside `Perf.measure()`; slow I/O there slows the measured code. Buffer and send asynchronously.
- `error` on a span is the raw thrown value; `fields.error` carries the same value for log sinks.
- Unregistering `LogMetricSink` removes perf log lines entirely, including rollups.

## Best practices

- Use `labels` for tags and dimensions, `fields` for log-only detail; a metrics sink should ignore `fields`.
- Never throw from `collect()`; wrap remote calls and drop on failure.
- `unref()` sockets and timers your sink owns, so they do not keep the process alive.

## Patterns and antipatterns

```ts
// Don't: await network I/O per metric inside collect()
public collect(metric: IPerfMetric): void {
  void fetch(this.url, { method: 'POST', body: JSON.stringify(metric) });
}

// Do: buffer and flush on a timer (or use UDP), as StatsdPerfSink does
public collect(metric: IPerfMetric): void {
  this.buffer.push(metric);
}
```

## Examples

### Count failed spans per name in memory

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { IPerfMetric, PerfSink } from '@spinajs/log';

@Singleton()
@Injectable(PerfSink)
export class FailureCounterSink extends PerfSink {
  public readonly Failures = new Map<string, number>();

  public collect(metric: IPerfMetric): void {
    if (metric.kind === 'span' && metric.error !== undefined) {
      this.Failures.set(metric.name, (this.Failures.get(metric.name) ?? 0) + 1);
    }
  }
}
```

## Related

- [Performance measurement](15-performance-measurement.md): the `Perf` facade and `LogMetricSink` config.
- [`@spinajs/di` multiple implementations](../di/06-multiple-implementations.md): how `Array.ofType()` lists work.
- `@spinajs/telemetry`: `PromMetricSink` and `InMemoryPerfSink`.
