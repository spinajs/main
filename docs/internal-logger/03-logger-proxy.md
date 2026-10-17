# Logger proxy

`InternalLoggerProxy` is a `Log` (from `@spinajs/log-common`) that forwards every call to `InternalLogger` under its own name. Use it where code expects a `Log` object but the real logger may not be registered or configured yet.

## How it works

1. Code builds or resolves a proxy with a name: `DI.resolve(InternalLoggerProxy, ['CLI'])` or `new InternalLoggerProxy('CLI')`.
2. A level call, eg. `proxy.warn({ path }, 'Missing ${path}')`, calls `InternalLogger.warn(fields, template, proxy.Name, ...args)`. The same [call forms](01-logging-api.md#call-forms) apply, with the name filled in.
3. `InternalLogger` buffers the entry or forwards it to the `__log__` logger, as in [Logging API](01-logging-api.md#how-it-works).
4. `proxy.write(entry)` copies the proxy's variables into `entry.Variables`, calls `InternalLogger.writeLogEntry(entry)` and resolves to an empty array.

Because forwarding goes through `InternalLogger`, a proxy taken early in boot reaches the real logger once `Configuration` is resolved and `__log__` is registered.

## API

| Member | Behaviour |
| --- | --- |
| `new InternalLoggerProxy(name, variables?, parent?)` | `name` becomes `Name` and the `logger` variable of every entry. `variables` and `parent` are stored but not used |
| `trace`, `debug`, `info`, `success`, `warn`, `error`, `fatal`, `security` | Forward to the matching `InternalLogger` method with `Name` |
| `write(entry)` | Merges `addVariable()` values into `entry.Variables` (they win on conflict), routes the entry, returns `Promise.allSettled([])` |
| `addVariable(name, value)` | Stores a variable used by `write()` only; level methods ignore it |
| `child(name, variables?)` | Returns the same proxy; `name` and `variables` are ignored |
| `timeStart(name)`, `timeEnd(name)` | Measures milliseconds between the two calls; `timeEnd` returns `0` for an unknown timer. A running timer is not restarted |
| `getLevel`, `setLevel`, `enableAll`, `disableAll`, ... | Inherited from `Log`. They change the stored level but do not filter: the level methods have no guard |
| `Targets` | Declared, never set |

## Who uses it

| Package | Where | When |
| --- | --- | --- |
| `@spinajs/log` | The `__log__` and `Log` factory | `DI.resolve(Log, [name])` before `Configuration` is resolved returns a proxy, cached in `Log.InternalLoggers` |
| `@spinajs/cli` | `resolveCliLog()` | No `Log` implementation is registered yet |
| `@spinajs/reflection` | Its logger lookup | No `Log` implementation is registered |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `InternalLoggerProxy` | `InternalLoggerProxy`; not decorated, so the default singleton lifetime; the constructor options are the name, variables and parent | `InternalLoggerProxy` | none shipped | `DI.register(MyProxy).as(InternalLoggerProxy)` before the first resolve. Subclass to add a lifetime, variables or child loggers |

Every place above resolves the class by type, so a registration under `InternalLoggerProxy` changes all of them.

### Proxy: custom implementation

The default proxy is a singleton: the first resolved name is reused for every later name. A subclass with `@NewInstance()` gives each caller its own name. This one also makes `child()` and constructor variables work.

```ts sample
import { DI, NewInstance } from '@spinajs/di';
import { InternalLoggerProxy } from '@spinajs/internal-logger';
import { ILogEntry, Log, LogVariables } from '@spinajs/log-common';

@NewInstance()
export class NamedInternalLoggerProxy extends InternalLoggerProxy {
  constructor(name: string, variables?: Record<string, unknown>, parent?: Log) {
    super(name, variables, parent);
    Object.entries(variables ?? {}).forEach(([key, value]) => this.addVariable(key, value));
  }

  public child(name: string, variables?: LogVariables): Log {
    return new NamedInternalLoggerProxy(`${this.Name}.${name}`, { ...this.Variables, ...variables }, this);
  }

  public write(entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    // Entry fields win over the proxy's variables, unlike the default.
    entry.Variables = { ...this.Variables, ...entry.Variables };
    return super.write(entry);
  }
}

// Register before anything resolves InternalLoggerProxy, eg. at the top of the entry module.
DI.register(NamedInternalLoggerProxy).as(InternalLoggerProxy);

const cliLog = DI.resolve(InternalLoggerProxy, ['CLI']);
const reflectionLog = DI.resolve(InternalLoggerProxy, ['reflection']);

cliLog.info({}, 'Starting');
reflectionLog.info({}, 'Scanning modules');
```

`write()` here applies only to entries passed to `write()` directly. The level methods still go straight to `InternalLogger`, so override them too if `addVariable()` values must reach every entry.

## Important behaviour

- The default proxy resolves as a singleton. `DI.resolve(InternalLoggerProxy, ['CLI'])` followed by `DI.resolve(InternalLoggerProxy, ['reflection'])` returns the `CLI` proxy twice, in the root and in child containers. `new InternalLoggerProxy(name)` always builds a fresh one.
- `addVariable()` and constructor `variables` do **not** reach entries from `info()`, `warn()` and the other level methods.
- `child()` returns the same proxy, so a child logger writes under the parent's name.
- Registering an unmodified `InternalLoggerProxy` as the `__log__` sink causes infinite recursion; see [Log sink](04-log-sink.md#patterns-and-antipatterns).

## Best practices

- Resolve the framework `Log` when one is registered and fall back to the proxy, as `@spinajs/cli` does: `DI.check(Log) ? DI.resolve(Log, [name]) : DI.resolve(InternalLoggerProxy, [name])`.
- Prefer `new InternalLoggerProxy(name)` over `DI.resolve(InternalLoggerProxy, [name])` when you need a specific name and do not want to depend on the registered lifetime.
- Pass fields per call rather than through `addVariable()`.

## Patterns and antipatterns

```ts
// Don't: with the default singleton, `jobsLog` is the proxy named 'CLI'
// when anything resolved InternalLoggerProxy with 'CLI' first.
const jobsLog = DI.resolve(InternalLoggerProxy, ['Jobs']);

// Do
const jobsLog = new InternalLoggerProxy('Jobs');
```

## Examples

### Get a logger that works before and after the logging system is ready

```ts sample
import { DI } from '@spinajs/di';
import { InternalLoggerProxy } from '@spinajs/internal-logger';
import { Log } from '@spinajs/log-common';

export function resolveToolLog(name: string): Log {
  // Before @spinajs/log is imported, resolving the abstract Log would build an object without log methods.
  return DI.check(Log) ? DI.resolve(Log, [name]) : new InternalLoggerProxy(name);
}

const log = resolveToolLog('Migrations');
log.timeStart('migrate');
log.info({ count: 3 }, 'Applying ${count} migrations');
log.success({ ms: log.timeEnd('migrate') }, 'Migrations applied in ${ms} ms');
```

## Related

- [Logging API](01-logging-api.md): the calls the proxy forwards to.
- [Log sink](04-log-sink.md): where forwarded entries end up.
- [`@spinajs/cli` running the CLI](../cli/01-running-the-cli.md): the CLI's fallback to the proxy.
- [Lifetimes in `@spinajs/di`](../di/04-lifetimes.md): `@NewInstance` and the singleton default.
