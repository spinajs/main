# `@spinajs/log`

The SpinaJS logging service. You resolve a named `Log`, call a level method, and the `logger` configuration routes the entry through filters to targets: console, NDJSON, rotating files, an in-memory ring, wrapper targets, or your own.

It does **not** ship network sinks: Grafana Loki is `@spinajs/log-source-graphana-loki` and OTLP is `@spinajs/log-otlp`. It does **not** collect metrics: Prometheus export is `@spinajs/telemetry`. The contracts it builds on (`Log`, `LogTarget`, `LogFilter`, `BatchQueue`, serializers) live in `@spinajs/log-common`, and `@spinajs/log` re-exports all of them.

## Install

```sh
npm install @spinajs/log
```

Import it once for its side effects: the import registers the `Log` factory, every built-in target, filter and archive strategy, and the `LogBotstrapper`.

## Features

| Feature | What it does |
| --- | --- |
| [Logging API](01-logging-api.md) | Resolve a named `Log`, the eight levels, the three call shapes, printf arguments, logger variables, child loggers, timers |
| [Configuration and rules](02-configuration-and-rules.md) | The `logger` config: target definitions, rules with glob names, level windows, `final`, defaults and schema validation |
| [Layouts](03-layouts.md) | `${...}` layout variables of text targets, conditional blocks, `${callsite}`, custom layout variables |
| [Console, JSON and memory targets](04-console-json-memory-targets.md) | `ConsoleTarget`, `JsonTarget`, `MemoryTarget`, `BlackHoleTarget` and their options |
| [File target](05-file-target.md) | `FileTarget` and `JsonFileTarget`: buffered appends through `@spinajs/fs`, write lock, queue cap |
| [File rotation and retention](06-file-rotation-and-retention.md) | `LogArchiveStrategy` and `LogRetentionStrategy`: shipped strategies and writing your own |
| [Wrapper targets](07-wrapper-targets.md) | `SplitGroupTarget`, `AutoFlushTarget`, `RetryingTarget`, `FallbackGroupTarget` and the write-rejection contract |
| [Custom targets](08-custom-targets.md) | Write a `LogTarget`, pick its DI lifetime, subclass `FileTarget`, take part in fallback chains |
| [Filters](09-filters.md) | Logger-level and per-target filter pipelines with `LevelFilter`, `MatchFilter`, `RateLimitFilter`, `WhenRepeatedFilter` |
| [Custom filters](10-custom-filters.md) | Write a `LogFilter`: drop, keep or rewrite entries |
| [Structured logging and serializers](11-structured-logging-and-serializers.md) | Merging-object fields, the `error` serializer, `registerSerializer`, `safeStringify`, `severityNumber` |
| [Async context and tracing](12-async-context-and-tracing.md) | `LogContext` ambient fields per request, `scalarContext`, W3C `traceparent` helpers, the context provider seam |
| [Runtime targets and levels](13-runtime-targets-and-levels.md) | `addTarget()` / `removeTarget()` on a live logger, `setLevel()` and friends |
| [Bootstrap, flushing and shutdown](14-bootstrap-flushing-and-shutdown.md) | `LogBotstrapper`, process error handlers, `flush()`, `Log.flushAll()`, `Log.clearLoggers()`, logging before configuration |
| [Performance measurement](15-performance-measurement.md) | `Perf` facade, `@Measure`, the default `LogMetricSink` and `logger.perf` config |
| [Custom perf sinks](16-custom-perf-sinks.md) | Write a `PerfSink` that receives every span, counter and per-request rollup |
| [Replacing the logger](17-replacing-the-logger.md) | The `Log` factory and the `__logImplementation__` registration: subclass or replace `FrameworkLogger` |
| [Browser build](18-browser-build.md) | The `browser` export condition: `BrowserConsoleTarget`, synchronous `LogContext`, persisted levels |

## Extension points at a glance

| Extension point | DI token and lifetime | Default | Page |
| --- | --- | --- | --- |
| Logger implementation | `'__logImplementation__'`, `@NewInstance()`, cached per name in `Log.Loggers` | `FrameworkLogger` | [Replacing the logger](17-replacing-the-logger.md) |
| Logger factory | `Log` and `'__log__'`, factory function | `logFactoryFunction` in `log.ts` | [Replacing the logger](17-replacing-the-logger.md#replacing-the-factory) |
| Log target | string `type` from config (`@Injectable('<type>')`); lifetime set by the class | `ConsoleTarget` | [Custom targets](08-custom-targets.md) |
| File entry format | subclass of `FileTarget`, `@PerInstanceCheck()` | `FileTarget.formatEntry()` renders the layout | [Custom targets](08-custom-targets.md#extending-filetarget-change-only-the-line-format) |
| Log filter | string `type` from config (`@Injectable('<type>')`), `@NewInstance()` | none | [Custom filters](10-custom-filters.md) |
| Rotation strategy | `LogArchiveStrategy`, `@NewInstance()`, picked by class name | `SizeLogArchiveStrategy` | [File rotation and retention](06-file-rotation-and-retention.md) |
| Retention strategy | `LogRetentionStrategy`, `@NewInstance()`, list picked by class names | `CountLogRetentionStrategy` | [File rotation and retention](06-file-rotation-and-retention.md) |
| Archive service | `LogArchiveService`, `@NewInstance()` | `LogArchiveService` | [File rotation and retention](06-file-rotation-and-retention.md#replacing-logarchiveservice) |
| Perf sink | `PerfSink`, resolved as `Array.ofType(PerfSink)` | `LogMetricSink` (singleton) | [Custom perf sinks](16-custom-perf-sinks.md) |
| Field serializer | `registerSerializer(field, fn)`, module-level map | `error` → `serializeError` | [Structured logging and serializers](11-structured-logging-and-serializers.md#custom-serializers) |
| Ambient context provider | `setLogContextProvider(fn)`, module-level function | `scalarContext(LogContext.active())` | [Async context and tracing](12-async-context-and-tracing.md#replacing-the-context-provider) |
| Perf scope backend | `setPerfScopeBackend(backend)`, module-level object | reads `perf` from `LogContext` | [Performance measurement](15-performance-measurement.md#perf-scope-backend) |
| Startup hook | `Bootstrapper`, list resolved with `Array.ofType(Bootstrapper)` | `LogBotstrapper` | [Bootstrap, flushing and shutdown](14-bootstrap-flushing-and-shutdown.md) |
| Layout variable | `ConfigVariable` (`@spinajs/configuration-common`) | `datetime`, `date`, `time`, ... | [Layouts](03-layouts.md#custom-layout-variables) |

## Quick start

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Log } from '@spinajs/log';

export async function startCheckout(orderId: number, userId: string): Promise<void> {
  await DI.resolve(Configuration);

  const log = DI.resolve(Log, ['checkout']);

  log.info('checkout started');
  log.info('user %s opened order %d', userId, orderId);
  log.info({ orderId, userId }, 'order ${orderId} validated');

  try {
    throw new Error('payment gateway timeout');
  } catch (err) {
    log.error(err as Error, 'order %d failed', orderId);
  }
}
```

With no `logger.targets` and `logger.rules` configured, every level of every logger goes to a colored console.

## Related packages

- [`@spinajs/di`](../di/README.md): resolves loggers, targets, filters, strategies and sinks by name or base class.
- [`@spinajs/configuration`](../configuration/README.md): supplies the `logger.*` keys and validates them against the package schema.
- [`@spinajs/configuration-common`](../configuration-common/README.md): `format()` renders layouts and file paths; its `ConfigVariable`s are the layout variables.
- [`@spinajs/fs`](../fs/README.md): storage behind `FileTarget` and its archives.
- [`@spinajs/electron`](../electron/README.md): replaces the logger implementation in the renderer process.
- `@spinajs/log-common`: the abstract `Log`, `LogTarget`, `LogFilter`, `PerfSink` and helpers this package implements.
- `@spinajs/internal-logger`: buffers log calls made before configuration resolves, then replays them here.
- `@spinajs/log-source-graphana-loki`, `@spinajs/log-otlp`: network targets (`GraphanaLogTarget`, `OtlpLogTarget`).
- `@spinajs/telemetry`: `PromMetricSink` and `InMemoryPerfSink`, two more `PerfSink`s.
- `@spinajs/http`: runs each action inside the `AsyncLocalStorage` that `LogContext` reads, and seeds `traceId` / `spanId`.
