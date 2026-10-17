# `@spinajs/internal-logger`

A logger for framework packages that run before the real logger exists. `InternalLogger` buffers messages until `Configuration` is resolved and a logger is registered under `__log__`, then forwards them. Messages still buffered when Node is about to exit go to the console.

It exists so `@spinajs/configuration` and its sources can log without importing `@spinajs/log`, which depends on configuration. It is **not** an application logger: it has no targets, rules or level filtering of its own. Application code uses `@spinajs/log`.

## Install

```sh
npm install @spinajs/internal-logger
```

The package depends on `@spinajs/di`, `@spinajs/configuration-common` and `@spinajs/log-common`. It does **not** depend on `@spinajs/log`; install that package to get messages delivered to log targets.

## Features

| Feature | What it does |
| --- | --- |
| [Logging API](01-logging-api.md) | The static `InternalLogger.<level>()` methods, their three call forms, and how an entry is built and routed |
| [Buffer flush and exit dump](02-buffer-flush-and-exit-dump.md) | The `InternalLogger` bootstrapper: flushes the buffer when `Configuration` resolves, prints leftovers on `beforeExit`; how to replace or extend it |
| [Logger proxy](03-logger-proxy.md) | `InternalLoggerProxy`, a `Log` that forwards to `InternalLogger`; used as the fallback logger before boot; how to replace it |
| [Log sink (`__log__`)](04-log-sink.md) | The `__log__` factory `InternalLogger` writes to; who registers it and how to plug in your own sink |

## Extension points at a glance

| Service | DI token and lifetime | Default implementation | How to replace or extend |
| --- | --- | --- | --- |
| `InternalLogger` bootstrapper | `Bootstrapper` list and `InternalLogger`; singleton | `InternalLogger` | Subclass with `@Injectable(Bootstrapper)`, `DI.unregister(InternalLogger)`. See [Buffer flush and exit dump](02-buffer-flush-and-exit-dump.md#services-and-extension-points) |
| `InternalLoggerProxy` | `InternalLoggerProxy`; singleton (no decorator) | `InternalLoggerProxy` | `DI.register(MyProxy).as(InternalLoggerProxy)`. See [Logger proxy](03-logger-proxy.md#services-and-extension-points) |
| `__log__` sink | String token `__log__`; factory, called on every resolve | Registered by `@spinajs/log` or `@spinajs/electron` | `DI.register((container, name) => ...).as('__log__')`. See [Log sink](04-log-sink.md#services-and-extension-points) |

## Quick start

```ts sample
import { InternalLogger } from '@spinajs/internal-logger';

export function loadPluginManifest(path: string, manifest: { name?: string }): boolean {
  if (!manifest.name) {
    InternalLogger.warn({ path }, 'Plugin manifest ${path} has no name, skipping it', 'PluginLoader');
    return false;
  }

  InternalLogger.info({ path, plugin: manifest.name }, 'Loaded plugin ${plugin} from ${path}', 'PluginLoader');
  return true;
}
```

Before `Configuration` is resolved both calls only fill the buffer. After it resolves, and with `@spinajs/log` imported, they reach the `PluginLoader` logger and its targets.

## Related packages

- [`@spinajs/configuration`](../configuration/README.md): the main user; its resolution gates the buffer flush.
- [`@spinajs/configuration-common`](../configuration-common/README.md): defines the `Configuration` token and the `format()` used for the exit dump.
- [`@spinajs/di`](../di/README.md): registration, `Bootstrapper`, factories and the `di.resolved.*` event this package relies on.
- [`@spinajs/cli`](../cli/README.md): falls back to `InternalLoggerProxy` when no `Log` is registered.
- [`@spinajs/configuration-aws-secretmanager-protocol`](../configuration-aws-secretmanager-protocol/README.md): logs protocol warnings and AWS SDK output through `InternalLogger`.
- `@spinajs/log`: registers the `__log__` factory that delivers entries to targets, and uses `InternalLoggerProxy` before boot.
- `@spinajs/log-common`: the `Log` base class, `LogLevel`, `ILogEntry` and `createLogMessageObject()`.
