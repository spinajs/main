# Replacing the logger

`DI.resolve(Log, [name])` does not build `FrameworkLogger` directly. It calls a **factory** registered for `Log`, which caches loggers by name and resolves the **implementation** registered as `'__logImplementation__'`. Both registrations can be replaced: subclass `FrameworkLogger` to change dispatch, or replace the factory to change how loggers are created and cached.

## How it works

At import, `log.ts` registers:

```ts
DI.register(logFactoryFunction).as('__log__'); // string token for packages that cannot import Log
DI.register(logFactoryFunction).as(Log);       // what DI.resolve(Log, [...]) calls
DI.register(FrameworkLogger).as('__logImplementation__');
```

`logFactoryFunction(container, name)`:

1. returns `Log.Loggers.get(name)` when present;
2. when no `Configuration` instance is resolved, returns (and caches in `Log.InternalLoggers`) an `InternalLoggerProxy`;
3. otherwise returns `container.resolve('__logImplementation__', [name])`.

`FrameworkLogger` is `@NewInstance()`; its `resolve()` reads config, builds rules, targets and filters, and adds itself to `Log.Loggers`. Factories are called on every resolve and never cached by DI, which is why the factory caches in `Log.Loggers`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Logger implementation | `'__logImplementation__'`, `@NewInstance()`; one per name via `Log.Loggers` | `FrameworkLogger` | `ElectronRendererLogger` (`@spinajs/electron`, renderer process) | Subclass `FrameworkLogger`, `DI.register(MyLogger).as('__logImplementation__')` after importing `@spinajs/log`, before the first logger resolves. |
| Logger factory | `Log` and `'__log__'`, factory functions (run on every resolve) | `logFactoryFunction` | the `@spinajs/electron` renderer factory | `DI.register(myFactory).as(Log)` and `.as('__log__')`. Keep the `Log.Loggers` cache. |
| Logger base | abstract `Log` (`@spinajs/log-common`), a `SyncService` | | `FrameworkLogger`, `InternalLoggerProxy` | Extend `Log` directly only for a logger that does not use rules and targets (eg. an IPC bridge). |

### `FrameworkLogger` members meant for overriding

| Member | Role |
| --- | --- |
| `resolve()` | Reads `logger` config, resolves filters, rules and targets, sets gates, registers in `Log.Loggers`. Call `super.resolve()`. |
| `write(entry)` | Runs filters and dispatches to targets. Returns `Promise<PromiseSettledResult<void>[]>`. |
| `matchRulesToLogger()` | Fills `this.Rules` from `this.Options.rules`. |
| `resolveLogTargets()` | Fills `this.Targets` from the matched rules. |
| `buildTargetDesc(def, ranges, rule)` | Resolves one target and its filters. |
| `recomputeGates()` | Recomputes `MinLevel` and `CaptureCallsite` from `this.Targets`. |
| `addTarget()`, `removeTarget()` | Runtime targets. |

Protected state: `Options`, `Rules`, `Targets`, `Filters`, `Variables`, `MinLevel`, `LevelOverride`, `Container`.

### Custom implementation: count errors per logger for a health check

```ts sample
import { DI, NewInstance } from '@spinajs/di';
import { FrameworkLogger, ILogEntry, LogLevel } from '@spinajs/log';

export const ErrorCounts = new Map<string, number>();

@NewInstance()
export class CountingLogger extends FrameworkLogger {
  public write(entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    if (entry.Level >= LogLevel.Error && entry.Variables.logger === this.Name) {
      ErrorCounts.set(this.Name, (ErrorCounts.get(this.Name) ?? 0) + 1);
    }
    return super.write(entry);
  }
}

DI.register(CountingLogger).as('__logImplementation__');

export function healthReport(): Record<string, number> {
  return Object.fromEntries(ErrorCounts);
}
```

Import this module after `@spinajs/log` and before the first `DI.resolve(Log, ...)`; loggers resolved earlier stay `FrameworkLogger`s in `Log.Loggers`.

### Replacing the factory

Replace the factory to change creation or caching. This one also passes the `variables` argument through to the implementation, so `DI.resolve(Log, [name, variables])` and `@Logger(name, variables)` set them on first creation.

```ts sample
import { DI, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InternalLoggerProxy } from '@spinajs/internal-logger';
import { Log } from '@spinajs/log';

const variableAwareLogFactory = (container: IContainer, name: string, variables?: Record<string, unknown>) => {
  const existing = Log.Loggers.get(name);
  if (existing) {
    return existing;
  }

  if (!DI.has(Configuration)) {
    const proxy = Log.InternalLoggers.get(name) ?? container.resolve(InternalLoggerProxy, [name]);
    Log.InternalLoggers.set(name, proxy);
    return proxy;
  }

  const log = container.resolve<Log>('__logImplementation__', [name]);
  for (const [key, value] of Object.entries(variables ?? {})) {
    log.addVariable(key, value);
  }
  return log;
};

DI.register(variableAwareLogFactory).as(Log);
DI.register(variableAwareLogFactory).as('__log__');
```

`child(name, variables)` also passes the parent's variables merged with the new ones, so with this factory a child inherits them.

## Important behaviour

- The factory and implementation are looked up on every `DI.resolve(Log, ...)`, but `Log.Loggers` short-circuits known names: a replacement affects only names not resolved yet.
- An implementation that does not call `FrameworkLogger.resolve()` (or `Log.Loggers.set()` itself) is rebuilt on every resolve.
- `@Logger()` first searches `DI.get(Array.ofType(Log))`, then calls `DI.resolve(Log, [name, variables])`, so it goes through your factory.
- `@spinajs/electron`'s renderer entry registers its own factory and `ElectronRendererLogger` the same way; importing it in a process replaces the defaults there.
- `Log.Loggers` is a static map on the shared `Log` class from `@spinajs/log-common`: every implementation shares it.

## Best practices

- Prefer a subclass of `FrameworkLogger` over a new `Log`: rules, targets, filters, gates and runtime targets keep working.
- Register replacements in a module imported right after `@spinajs/log`, before configuration resolves, so no logger is created with the default.
- Keep the factory's three steps (cache, pre-config proxy, implementation) when replacing it.

## Patterns and antipatterns

```ts
// Don't: register the implementation under Log; DI then builds a fresh logger on every resolve, bypassing the cache
DI.register(CountingLogger).as(Log);

// Do: replace the implementation token, keep the factory
DI.register(CountingLogger).as('__logImplementation__');
```

## Examples

### Send every entry of a secondary process to the main process

```ts sample
import { DI, NewInstance } from '@spinajs/di';
import { FrameworkLogger, ILogEntry } from '@spinajs/log';

// Worker process: write locally through targets, and forward to the parent over IPC.
@NewInstance()
export class ForwardingLogger extends FrameworkLogger {
  public write(entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    if (process.send && entry.Variables.logger === this.Name) {
      process.send({ kind: 'log', level: entry.Level, variables: { logger: entry.Variables.logger, message: entry.Variables.message } });
    }
    return super.write(entry);
  }
}

DI.register(ForwardingLogger).as('__logImplementation__');
```

## Related

- [Logging API](01-logging-api.md): what callers see.
- [`@spinajs/di` factories](../di/08-factories.md): factory registrations and their arguments.
- [`@spinajs/electron` renderer logging](../electron/04-renderer-logging.md): a full replacement of factory and implementation.
