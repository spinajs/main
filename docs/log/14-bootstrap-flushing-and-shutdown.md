# Bootstrap, flushing and shutdown

`LogBotstrapper` wires the package into the process at startup: schema, ambient context, perf scope, a drain on clean exit, and handlers for uncaught errors. Buffered targets are drained with `flush()`, `Log.flushAll()` and `Log.clearLoggers()`. Loggers used before configuration exists go through `@spinajs/internal-logger`.

## How it works

### Startup

1. Importing `@spinajs/log` registers `LogBotstrapper` under `Bootstrapper` (`@Injectable(Bootstrapper)`).
2. Your app entry runs every bootstrapper: `for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();`. The DI container does not run them for you.
3. `LogBotstrapper.bootstrap()`:
   1. registers the `logger` configuration schema (also registered at import);
   2. once per process, adds `process.on('beforeExit', () => Log.flushAll())`;
   3. installs the ambient context provider: `setLogContextProvider(() => scalarContext(LogContext.active()))`;
   4. installs the perf scope backend with `wirePerfScope()`;
   5. unless `process.env.TESTING` is set, replaces its own `uncaughtException` and `unhandledRejection` handlers. They log `fatal` on the `process` logger when `Configuration` is resolved, else print to `console.error`, and set `process.exitCode = 1`.

### Logging before configuration

1. While no `Configuration` instance is resolved, `DI.resolve(Log, [name])` returns an `InternalLoggerProxy`, cached per name in `Log.InternalLoggers`.
2. The proxy forwards every call to `InternalLogger`, which buffers entries.
3. When `Configuration` resolves (`di.resolved.Configuration`), the `InternalLogger` bootstrapper writes the buffer through the real loggers (`DI.resolve('__log__', [name])`).
4. Entries still buffered at `beforeExit` are printed to the console.

### Flushing and teardown

| Call | Effect |
| --- | --- |
| `log.flush()` | `forceFlush()` on each target of this logger, `Promise.allSettled`. Does not close anything. A logger without targets resolves at once. |
| `Log.flushAll()` (static) | `flush()` on every logger in `Log.Loggers`. Never rejects. |
| `Log.clearLoggers()` (static) | `flushAll()`, then `dispose()` each logger, clear `Log.Loggers`, then `dispose()` each internal logger proxy. |
| DI container dispose | Disposes target singletons: `FileTarget.dispose()` stops its timer, flushes and stops the archive service; wrappers dispose their inner targets. |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `process.env.TESTING` | env var | unset | any non-empty value | Set: `LogBotstrapper` does not install the `uncaughtException` / `unhandledRejection` handlers (keeps mocha output). |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Startup hook | `Bootstrapper`, list resolved with `Array.ofType(Bootstrapper)` | `LogBotstrapper` | `InternalLogger` (from `@spinajs/internal-logger`) | Add your own `@Injectable(Bootstrapper)`. Remove the default with `DI.unregister(LogBotstrapper)` before the bootstrap loop, then do its work yourself. |
| Pre-configuration logger | `InternalLoggerProxy`, returned by the `Log` factory | `InternalLoggerProxy` | | Replace the factory, see [Replacing the logger](17-replacing-the-logger.md#replacing-the-factory). |

### Replacing `LogBotstrapper`: exit after an uncaught exception

The default handlers log, set exit code 1 and keep the process running. To log, drain and exit at once, unregister the default and install your own; keep the context and perf wiring.

```ts sample
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Log, LogBotstrapper, LogContext, scalarContext, setLogContextProvider, wirePerfScope } from '@spinajs/log';

DI.unregister(LogBotstrapper);

@Injectable(Bootstrapper)
export class FailFastLogBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    setLogContextProvider(() => scalarContext(LogContext.active()));
    wirePerfScope();

    process.once('beforeExit', () => void Log.flushAll());

    const crash = (err: unknown, kind: string) => {
      if (DI.has(Configuration)) {
        DI.resolve(Log, ['process']).fatal(err instanceof Error ? err : new Error(String(err)), `${kind}, exiting`);
      } else {
        console.error(kind, err);
      }
      void Log.flushAll().finally(() => process.exit(1));
    };

    process.on('uncaughtException', (err) => crash(err, 'uncaught exception'));
    process.on('unhandledRejection', (reason) => crash(reason, 'unhandled rejection'));
  }
}
```

## Important behaviour

- **Uncaught exceptions do not crash the process** once `LogBotstrapper` has run outside tests: its handler logs `fatal` and returns. Decide whether that is what you want.
- **A process that ends after one exits with 1.** Both handlers set `process.exitCode = 1`, so a boot that fails at a top-level `await` or in a boot promise nothing catches (an invalid configuration) does not end with 0. An explicit `process.exit(code)` still exits with `code`.
- `beforeExit` runs only on a clean drain of the event loop. `process.exit()`, signals and crashes skip it: call `await Log.flushAll()` yourself in those paths.
- File target timers (flush, rotation) are `unref()`'d, so a `FileTarget` does not keep the event loop alive and `beforeExit` still fires.
- `flush()` does not dispose; targets stay usable after it.
- `Log.clearLoggers()` disposes the internal logger proxies but does not empty `Log.InternalLoggers`, so a later resolve before configuration returns a disposed proxy.
- Without the bootstrap loop, entries get no ambient context and the perf rollup has no scope, but logging itself works.
- Calling `bootstrap()` twice does not add a second `beforeExit` drain, and swaps (not stacks) the error handlers.

## Best practices

- Run the bootstrap loop once, early in your entry point, before resolving app services.
- In signal handlers (`SIGTERM`, `SIGINT`), `await Log.flushAll()` before `process.exit()`.
- In tests, set `TESTING` and call `await Log.clearLoggers()` in `beforeEach` to start from fresh loggers.

## Patterns and antipatterns

```ts
// Don't: buffered file and network entries are lost
process.on('SIGTERM', () => process.exit(0));

// Do
process.on('SIGTERM', () => {
  void Log.flushAll().finally(() => process.exit(0));
});
```

## Examples

### Graceful shutdown of a worker

```ts sample
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Log } from '@spinajs/log';

export async function startWorker(work: (log: Log) => Promise<void>): Promise<void> {
  await DI.resolve(Configuration);
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }

  const log = DI.resolve(Log, ['worker']);

  const stop = async (signal: string) => {
    log.info({ signal }, 'received ${signal}, shutting down');
    await Log.flushAll();
    await DI.dispose();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));

  await work(log);
}
```

## Related

- [`@spinajs/di` service lifecycle](../di/10-service-lifecycle.md): `Bootstrapper`, `resolve()` and `dispose()`.
- [File target](05-file-target.md): what is buffered and how it drains.
- [Async context and tracing](12-async-context-and-tracing.md): the provider `bootstrap()` installs.
