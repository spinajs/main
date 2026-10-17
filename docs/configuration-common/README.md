# `@spinajs/configuration-common`

Shared contracts of SpinaJS configuration and the `${...}` templating engine. It defines the abstract `Configuration`, `ConfigurationSource`, `ConfigVarProtocol` and `ConfigVariable` types that other packages implement, plus `format()`, which expands `${...}` placeholders in log layouts and file paths.

It does **not** load configuration. The working `Configuration` service, the file sources and schema validation live in [`@spinajs/configuration`](../configuration/README.md), which re-exports everything from this package.

## Install

```sh
npm install @spinajs/configuration-common
```

The only runtime dependency is `@spinajs/di`. The date variables also import `luxon`, which the package does not declare (see [Built-in variables](02-built-in-variables.md#important-behaviour)).

### Entry points

| Import | Resolves to | Contents |
| --- | --- | --- |
| `@spinajs/configuration-common` (Node) | `lib/*/index.js` | everything |
| `@spinajs/configuration-common` (bundler with the `browser` condition) | `lib/*/index.browser.js` | everything except the Node-only variables (`env`, `path`, `hostname`, `user`, `platform`, `arch`, `cwd`, `pid`, `uuid`) |
| `@spinajs/configuration-common/browser` | `lib/*/index.browser.js` | same as above, on any platform |

## Features

| Feature | What it does |
| --- | --- |
| [Templating with `format()`](01-templating.md) | Expands `${name}`, `${name:option}` and `${?name}...${/name}` in a layout string. |
| [Built-in variables](02-built-in-variables.md) | The `${date}`, `${env:NAME}`, `${path:temp}`, `${uuid}`, ... variables every `format()` call sees. |
| [Custom variables](03-custom-variables.md) | Add, override or remove a global `${...}` variable by registering a `ConfigVariable` in DI. |
| [The `Configuration` service](04-configuration-service.md) | The abstract config service contract, its hooks (`configure`, `onConfigLoad`) and how to replace or extend it. |
| [Configuration sources](05-configuration-sources.md) | `ConfigurationSource` and the `StaticConfigurationSource()` factory: where config values come from, in which order. |
| [Config var protocols](06-config-var-protocols.md) | `ConfigVarProtocol` and `ConfigVar`: resolve values like `fs-path://` or `aws-parameters://` at load time, eagerly or lazily. |
| [Environment names](07-environment-names.md) | `normalizeEnvironment()`: the one rule that maps `APP_ENV` to the `dev` / `prod` file suffixes. |

### Extension points at a glance

| Extension point | DI token | Collected by | Page |
| --- | --- | --- | --- |
| `ConfigVariable` | `ConfigVariable`, singleton, root container | `format()`, on its first call | [Custom variables](03-custom-variables.md) |
| `Configuration` | `Configuration`, singleton | every `@Config`, `@Autoinject(Configuration)`, `DI.resolve(Configuration)` | [The `Configuration` service](04-configuration-service.md) |
| `ConfigurationSource` | `ConfigurationSource`, singleton | `Configuration.resolve()` | [Configuration sources](05-configuration-sources.md) |
| `StaticConfigurationSource()` | a factory producing a `ConfigurationSource` class | same as above | [Configuration sources](05-configuration-sources.md#staticconfigurationsource-factory) |
| `ConfigVarProtocol` | `ConfigVarProtocol`, singleton, root container | `Configuration.load()` | [Config var protocols](06-config-var-protocols.md) |
| `ConfigVar` | none: returned from `getVar()` | the configuration proxy, on read | [Config var protocols](06-config-var-protocols.md#configvar-lazy-values) |
| `IConfigEntryOptions` | `declare module '@spinajs/configuration-common'` | `@Config(path, options)` | [The `Configuration` service](04-configuration-service.md#iconfigentryoptions-augmentation) |
| `IConfigurable.configure` | a function on a top-level config section | `Configuration.resolve()` | [The `Configuration` service](04-configuration-service.md#hooks-in-config-files) |
| `IConfigLike.onConfigLoad` | a function exported by a JS config file | `JsFileSource` | [The `Configuration` service](04-configuration-service.md#hooks-in-config-files) |

## Quick start

```ts sample
import { format } from '@spinajs/configuration-common';

// "17/10/2026 [alice] user logged in"
const line = format({ user: 'alice', message: 'user logged in' }, '${date} [${user}] ${message}');

// "/tmp/spinajs/audit-4120.log" on Linux
const logFile = format({ logger: 'audit' }, '${path:temp}/spinajs/${logger}-${pid}.log');

console.log(line, logFile);
```

The runnable scripts in [`packages/configuration-common/examples/`](../../packages/configuration-common/examples/README.md) show the same features end to end.

## Related packages

- [`@spinajs/configuration`](../configuration/README.md): implements `Configuration` (`FrameworkConfiguration`), ships `JsFileSource` and `JsonFileSource`, validates config with schemas, and re-exports this package.
- [`@spinajs/di`](../di/README.md): the container every extension point here is registered in (`@Injectable`, `Array.ofType`, `DI.unregister`).
- [`@spinajs/configuration-db-source`](../configuration-db-source/README.md): a `ConfigurationSource` (order `999`) that loads exposed entries from the database and augments `IConfigEntryOptions`.
- [`@spinajs/configuration-fs-protocol`](../configuration-fs-protocol/README.md): the `fs-path://` protocol, a lazy `ConfigVarProtocol`.
- [`@spinajs/configuration-aws-secretmanager-protocol`](../configuration-aws-secretmanager-protocol/README.md): the `aws-parameters://` protocol.
- [`@spinajs/log`](../log/README.md): calls `format()` for target layouts and log file paths.
- [`@spinajs/electron`](../electron/README.md): adds the `${electron-path:...}` variable and an `ElectronRendererConfiguration`.
