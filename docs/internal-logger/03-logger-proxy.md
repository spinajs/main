# Logger proxy

`InternalLoggerProxy` is a `Log` (from `@spinajs/log-common`) that forwards every call to `InternalLogger` under its own name. Use it where code expects a `Log` object but the real logger may not be registered or configured yet.

## How it works

1. Code builds or resolves a proxy with a name: `DI.resolve(InternalLoggerProxy, ['CLI'])` or `new InternalLoggerProxy('CLI')`.
2. A level call, eg. `proxy.warn({ path }, 'Missing ${path}')`, builds an entry named `proxy.Name` with the proxy's variables and passes it to `InternalLogger.writeLogEntry()`. The call forms are those of `Log`: `(message, ...args)`, `(err, message, ...args)` and `(fields, template, ...args)`.
3. `InternalLogger` buffers the entry or forwards it to the `__log__` logger, as in [Logging API](01-logging-api.md#how-it-works).
4. `proxy.write(entry)` routes a copy of the entry with the proxy's variables added (the entry's own fields win) through `InternalLogger.writeLogEntry()` and resolves to an empty array.

Because forwarding goes through `InternalLogger`, a proxy taken early in boot reaches the real logger once `Configuration` is resolved and `__log__` is registered.

## API

| Member | Behaviour |
| --- | --- |
| `new InternalLoggerProxy(name, variables?, parent?)` | `name` becomes `Name` and the `logger` variable of every entry. `variables` are added to every entry; `parent` is stored but not used |
| `trace`, `debug`, `info`, `success`, `warn`, `error`, `fatal`, `security` | Build an entry with `Name` and the proxy's variables, then route it through `InternalLogger.writeLogEntry()` |
| `write(entry)` | Routes a copy of the entry with the proxy's variables added (the entry's fields win on conflict), returns `Promise.allSettled([])` |
| `addVariable(name, value)` | Stores a variable added to every later entry |
| `child(name, variables?)` | Returns a new proxy named `<Name>.<name>` with the parent's variables plus `variables` |
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
| `InternalLoggerProxy` | `InternalLoggerProxy`; `@NewInstance()`, so every resolve builds a new proxy; the constructor options are the name, variables and parent | `InternalLoggerProxy` | none shipped | `DI.register(MyProxy).as(InternalLoggerProxy)` before the first resolve |

Every place above resolves the class by type, so a registration under `InternalLoggerProxy` changes all of them.

### Proxy: custom implementation

Subclass the proxy to add fields to every entry it builds. Here each pre-boot message carries the process id.

```ts sample
import { DI, NewInstance } from '@spinajs/di';
import { InternalLoggerProxy } from '@spinajs/internal-logger';
import { Log } from '@spinajs/log-common';

@NewInstance()
export class PidInternalLoggerProxy extends InternalLoggerProxy {
  constructor(name: string, variables?: Record<string, unknown>, parent?: Log) {
    super(name, { pid: process.pid, ...variables }, parent);
  }
}

// Register before anything resolves InternalLoggerProxy, eg. at the top of the entry module.
DI.register(PidInternalLoggerProxy).as(InternalLoggerProxy);

const cliLog = DI.resolve(InternalLoggerProxy, ['CLI']);
cliLog.info({}, 'Starting');
```

`child()` returns a plain `InternalLoggerProxy`; it still carries `pid`, because a child copies its parent's variables.

## Important behaviour

- Every `DI.resolve(InternalLoggerProxy, [name])` builds a new proxy with that name; the container does not cache it. `@spinajs/log` caches its proxies in `Log.InternalLoggers` itself.
- In the level methods the proxy's variables override `level`, `logger` and `message` when they use those keys, as in `@spinajs/log`; fields passed to the call override the proxy's variables.
- Registering an unmodified `InternalLoggerProxy` as the `__log__` sink causes infinite recursion; see [Log sink](04-log-sink.md#patterns-and-antipatterns).

## Best practices

- Resolve the framework `Log` when one is registered and fall back to the proxy, as `@spinajs/cli` does: `DI.check(Log) ? DI.resolve(Log, [name]) : DI.resolve(InternalLoggerProxy, [name])`.
- Pass fields per call for values that change per message; use `addVariable()` or `child()` for values shared by every message.

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
