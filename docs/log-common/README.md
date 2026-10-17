# `@spinajs/log-common`

The shared, browser-safe contracts of the SpinaJS logging stack: the `Log` and `LogTarget` base classes, log levels, log entries, filters, serializers, a batching queue and the `Perf` instrumentation facade. Depend on it to write a custom target, filter, logger or perf sink without a dependency on `@spinajs/log`.

It does **not** route, configure or write logs by itself. Rule matching, config reading, the shipped targets and `FrameworkLogger` live in [`@spinajs/log`](../log/README.md), which re-exports everything from this package. Without a registration for `Log` in DI, `DI.resolve(Log)` and `@Logger()` have nothing to build.

## Install

```sh
npm install @spinajs/log-common
```

The package uses no `node:*` module. It runs in Node and in the browser.

## Features

| Feature | What it does |
| --- | --- |
| [Logger contract](01-logger-contract.md) | The abstract `Log` class, the `@Logger()` decorator, child loggers, variables, timers, flushing and a custom `Log` implementation |
| [Log levels](02-log-levels.md) | `LogLevel`, name maps, OpenTelemetry severity numbers, runtime level overrides and their browser persistence |
| [Log entries and message templates](03-log-entries.md) | `createLogMessageObject()`, the `ILogEntry` shape, call forms, `renderTemplate()` and `renderValue()` |
| [Ambient log context](04-ambient-log-context.md) | `setLogContextProvider()`: the seam that adds request-scoped fields to every entry |
| [Serializers](05-serializers.md) | The field serializer registry, `serializeError()`, `safeStringify()` and custom serializers |
| [Log targets](06-log-targets.md) | The abstract `LogTarget` sink, its write contract, the drop hook, lifetimes, and the target and rule config shapes |
| [Log filters](07-log-filters.md) | The abstract `LogFilter`, the shipped `WhenRepeatedFilter`, and custom filters |
| [Batch queue](08-batch-queue.md) | `BatchQueue<T>`: size and interval flushing, a hard cap and requeue, for buffered targets |
| [Perf instrumentation](09-perf-instrumentation.md) | The `Perf` facade, custom `PerfSink` receivers and the per-request scope backend |

## Extension points at a glance

| Extension point | How you plug in | Page |
| --- | --- | --- |
| `Log` | `DI.register(factory).as(Log)` | [Logger contract](01-logger-contract.md#log-custom-implementation) |
| `LogTarget` | `@Injectable('<TypeName>')`, referenced by `type` in config | [Log targets](06-log-targets.md#logtarget-custom-implementation) |
| `LogFilter` | `@Injectable('<TypeName>')` + `@NewInstance()`, referenced by `type` | [Log filters](07-log-filters.md#logfilter-custom-implementation) |
| `WhenRepeatedFilter` | Subclass, override `keyOf()` | [Log filters](07-log-filters.md#whenrepeatedfilter-extending-it) |
| Field serializers | `registerSerializer(field, fn)` | [Serializers](05-serializers.md#custom-serializer) |
| Ambient context | `setLogContextProvider(fn)` | [Ambient log context](04-ambient-log-context.md#custom-provider) |
| `PerfSink` | `@Injectable(PerfSink)` | [Perf instrumentation](09-perf-instrumentation.md#perfsink-custom-implementation) |
| Perf scope backend | `setPerfScopeBackend(backend)` | [Perf instrumentation](09-perf-instrumentation.md#perf-scope-backend-custom-implementation) |
| `BatchQueue` hooks | `onFlush`, `onOverflow`, `requeueFront()` | [Batch queue](08-batch-queue.md#using-it-in-a-custom-target) |

## Quick start

Write a target, resolve it the way `@spinajs/log` does (by its DI name, with its config entry), and hand it an entry.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { createLogMessageObject, ICommonTargetOptions, ILogEntry, LogLevel, LogTarget } from '@spinajs/log-common';

@Injectable('AuditTrailTarget')
class AuditTrailTarget extends LogTarget<ICommonTargetOptions> {
  public readonly Lines: string[] = [];

  public write(entry: ILogEntry): void {
    if (!this.Options.enabled) return;
    this.Lines.push(`${entry.Variables.level} ${entry.Variables.logger}: ${entry.Variables.message}`);
  }
}

const target = DI.resolve<AuditTrailTarget>('AuditTrailTarget', [{ name: 'audit', type: 'AuditTrailTarget' }]);
target.write(createLogMessageObject('User %s signed in', '', LogLevel.Info, 'auth', {}, 'u-42'));

console.log(target.Lines); // [ 'INFO auth: User u-42 signed in' ]
```

## Related packages

- [`@spinajs/log`](../log/README.md): the implementation. `FrameworkLogger`, rules, config, the console, file, JSON and memory targets, wrapper targets, filters and `LogMetricSink`.
- [`@spinajs/di`](../di/README.md): every extension point here is a DI registration; see [lifetimes](../di/04-lifetimes.md) and [factories](../di/08-factories.md).
- [`@spinajs/configuration-common`](../configuration-common/README.md): `format()` renders target layouts; [built-in variables](../configuration-common/02-built-in-variables.md) such as `${datetime}`.
- `@spinajs/internal-logger`: a `Log` subclass that buffers entries until the configuration module is ready.
- `@spinajs/log-otlp` and `@spinajs/log-source-graphana-loki`: `LogTarget` implementations built on `BatchQueue` and `OnDropped`.
- `@spinajs/telemetry`: `PerfSink` implementations (`InMemoryPerfSink`, `PromMetricSink`).
