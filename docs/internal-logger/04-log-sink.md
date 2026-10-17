# Log sink (`__log__`)

`InternalLogger` never imports a logger class. It resolves the string token `__log__` with the logger name and calls `write(entry)` on the result. Whatever is registered under `__log__` decides where internal messages go.

## How it works

1. A logging package registers a factory: `DI.register((container, name) => ...).as('__log__')`. `@spinajs/log` does this when its module is imported.
2. After `Configuration` is resolved, `InternalLogger` calls `DI.resolve('__log__', [loggerName])` for each entry: in [`writeLogEntry()`](01-logging-api.md#how-it-works) and in the [buffer flush](02-buffer-flush-and-exit-dump.md#how-it-works).
3. The container calls the last registered factory with the container and `loggerName`. A factory runs on every resolve; caching is the factory's job.
4. `InternalLogger` calls `logger.write(entry)` on the returned object and reports rejected results with `console.error`.
5. When nothing is registered, `DI.resolve('__log__', ...)` returns `null`. `writeLogEntry()` buffers the entry; the flush drops it.

`InternalLogger` does not resolve `__log__` before `Configuration` is resolved, so a factory may assume configuration is loaded.

## Shipped sinks

| Registered by | Factory behaviour | Result |
| --- | --- | --- |
| `@spinajs/log` | Returns the cached `Log.Loggers` entry for the name. Before `Configuration` is resolved, returns an `InternalLoggerProxy`. Otherwise resolves `__logImplementation__` with the name | The framework logger with its targets and rules |
| `@spinajs/electron` (renderer entry) | Returns the cached `ElectronRendererLogger.Loggers` entry, or resolves `__logImplementation__` | `ElectronRendererLogger`, which sends entries to the main process |

Both packages register the same factory under `Log` as well. Other packages resolve `__log__` directly as a logger (`@spinajs/tasks`, `@spinajs/threading`), so they call level methods such as `info()` on it, not only `write()`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Log sink | String token `__log__`; a factory `(container: IContainer, name: string) => Log`, called on every resolve. The last registration wins | The `@spinajs/log` factory | The `@spinajs/electron` renderer factory | `DI.register(myFactory).as('__log__')` after the module that registers the default is imported, and before `Configuration` resolves. Remove a sink with `DI.unregister(factory)` |

Rules for a custom sink:

- Return a full `Log`: `InternalLogger` only calls `write(entry)`, but other packages call the level methods on the same object.
- Make `write()` deliver the entry itself. It must not call `InternalLogger.writeLogEntry()` or `InternalLoggerProxy.prototype.write()`, which resolve `__log__` again.
- Cache one instance per name in the factory, so per-logger state (timers, variables) survives between calls.
- Register it as an arrow function. The container treats arrow functions as factories and classes as types.

### Sink: custom implementation

Write internal messages as JSON lines to stderr, without `@spinajs/log`. The sink extends `InternalLoggerProxy`, so its level methods already route through `InternalLogger`; only `write()` changes.

```ts sample
import { DI, IContainer } from '@spinajs/di';
import { InternalLogger, InternalLoggerProxy } from '@spinajs/internal-logger';
import { ILogEntry, Log, LogLevel } from '@spinajs/log-common';

export class JsonLinesLog extends InternalLoggerProxy {
  public write(entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    const line = JSON.stringify({ ...entry.Variables, severity: LogLevel[entry.Level] });
    process.stderr.write(`${line}\n`);
    return Promise.allSettled([]);
  }
}

const sinks = new Map<string, Log>();

DI.register((_container: IContainer, name: string) => {
  if (!sinks.has(name)) {
    sinks.set(name, new JsonLinesLog(name));
  }
  return sinks.get(name)!;
}).as('__log__');

// Buffered now; written as a JSON line once Configuration is resolved and InternalLogger's bootstrapper flushes.
InternalLogger.info({ port: 8080 }, 'Listening on ${port}', 'Http');
```

## Important behaviour

- A factory runs on every `DI.resolve('__log__', ...)`, and `InternalLogger.writeLogEntry()` resolves it twice per forwarded entry. Keep the factory cheap.
- Registration order matters: importing `@spinajs/log` after your registration makes the `@spinajs/log` factory the last one, and it wins.
- `InternalLogger` passes the logger name as the only constructor option. An entry from the [string call form](01-logging-api.md#call-forms) with two arguments has the name `null`.
- A sink's rejected `write()` is reported with `console.error` and the entry is gone; it is not buffered again.

## Best practices

- In tests, register a recording sink to assert on messages from configuration code instead of spying on console output.
- Keep a sink's `write()` synchronous or self-contained. `InternalLogger` does not await it, and a process exit can cut a pending write.

## Patterns and antipatterns

```ts
// Don't: InternalLoggerProxy.write() calls InternalLogger.writeLogEntry(), which resolves
// `__log__` again and gets the same proxy back: infinite recursion once Configuration is resolved.
DI.register((_c: IContainer, name: string) => new InternalLoggerProxy(name)).as('__log__');

// Do: a sink whose write() delivers the entry itself.
DI.register((_c: IContainer, name: string) => new JsonLinesLog(name)).as('__log__');
```

## Examples

### Capture configuration messages in a test

```ts sample
import { DI, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InternalLogger, InternalLoggerProxy } from '@spinajs/internal-logger';
import { ILogEntry } from '@spinajs/log-common';

class RecordingLog extends InternalLoggerProxy {
  public static Entries: ILogEntry[] = [];

  public write(entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    RecordingLog.Entries.push(entry);
    return Promise.allSettled([]);
  }
}

export async function configurationWarnings(): Promise<string[]> {
  DI.register((_c: IContainer, name: string) => new RecordingLog(name)).as('__log__');
  DI.resolve(InternalLogger).bootstrap();

  await DI.resolve(Configuration);

  return RecordingLog.Entries.filter((e) => e.Variables.level === 'WARN').map((e) => String(e.Variables.message));
}
```

## Related

- [Logging API](01-logging-api.md): when `InternalLogger` resolves the sink.
- [Buffer flush and exit dump](02-buffer-flush-and-exit-dump.md): the flush that delivers buffered entries to the sink.
- [Logger proxy](03-logger-proxy.md): the base class used by the sink examples.
- [Factories in `@spinajs/di`](../di/08-factories.md): how factory registrations are called.
- [Named services in `@spinajs/di`](../di/07-named-services.md): string tokens and named resolution.
