# `@spinajs/configuration`

The configuration service of SpinaJS. `FrameworkConfiguration` loads JS and JSON config files and every other registered `ConfigurationSource`, merges them into one tree, resolves protocol values (`fs-path://`, `aws-secrets://`), validates each module against its JSON schema and serves it through `get()`, `@Config` and the config-selected service decorators.

It does **not** watch config files for changes: `ConfigurationOptions.watchFileChanges` exists in the contract but nothing reads it. Values you `set()` or `merge()` at runtime are validated against the same schemas, and a refused value is not applied.

The package re-exports everything from `@spinajs/configuration-common` (`Configuration`, `ConfigurationSource`, `ConfigVarProtocol`, `ConfigVar`, `StaticConfigurationSource`, `format`, ...), so you import both from `@spinajs/configuration`.

## Install

```sh
npm install @spinajs/configuration
```

## Features

| Feature | What it does |
| --- | --- |
| [Configuration service](01-configuration-service.md) | `FrameworkConfiguration`: boot steps, `get` / `set` / `merge` / `load`, options, CLI arguments, `configure()` hooks |
| [Environments](02-environments.md) | How `APP_ENV`, `NODE_ENV` and `--env` pick the environment, the `*.dev.js` / `*.prod.json` suffixes, the `configuration.isProduction` flags |
| [Config files](03-config-files.md) | `JsFileSource` and `JsonFileSource`: search directories, merge order, `onConfigLoad`, workspaces and ESM mode |
| [Custom configuration sources](04-custom-configuration-sources.md) | Add a source (database, remote service, YAML), `Order`, `StaticConfigurationSource`, the `__configuration__` value |
| [Config var protocols](05-config-var-protocols.md) | `ConfigVarProtocol` and `ConfigVar`: resolve `proto://...` strings at load time, eagerly or lazily |
| [Schema validation](06-schema-validation.md) | `__configurationSchema__`, `registerConfigurationSchema`, defaults, coercion, `InvalidConfiguration` and late schemas |
| [Injecting config values](07-injecting-config-values.md) | `@Config`, `cfg()`, `_cfg()`; per-container reads in child containers |
| [Config-selected services](08-config-selected-services.md) | Pick implementations by name in config: `@AutoinjectService`, `@AutoinjectNamedService`, `@AutoinjectNamedServices`, `service()` |
| [Replacing the configuration service](09-replacing-the-configuration-service.md) | Subclass `FrameworkConfiguration` (tests, workers), write your own `Configuration`, one per child container |
| [Browser configuration](10-browser-configuration.md) | `BrowserFrameworkConfiguration` and the `@spinajs/configuration/browser` entry, with no `fs`, `glob` or `ajv` |

## Quick start

A config file `config/mailer.js` in your project:

```js
export default {
  mailer: {
    fromAddress: 'no-reply@example.com',
    retryCount: 3,
  },
};
```

Boot the configuration and read it:

```ts sample
import { DI } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';

class Mailer {
  @Config('mailer.fromAddress', { defaultValue: 'no-reply@localhost' })
  protected From: string;

  public describe() {
    return `sending as ${this.From}`;
  }
}

async function main() {
  DI.setESMModuleSupport();

  const configuration = await DI.resolve(Configuration);
  const retries = configuration.get<number>('mailer.retryCount', 1);

  const mailer = DI.resolve(Mailer);
  console.log(mailer.describe(), retries);
}

void main();
```

## Typed paths

`Configuration.get()` and `@Config()` return the declared type for every path listed in the `ConfigPaths` interface of `@spinajs/configuration-common`. Paths that are not declared keep the untyped `get<T>(path, defaultValue?)` overload.

```ts
declare module '@spinajs/configuration-common' {
  interface ConfigPaths {
    'hooks.timeoutMs': number;
  }
}

const timeout = config.get('hooks.timeoutMs'); // number
```

`spinajs generate:config-types` writes these declarations from the config module schemas in `app.manifest.json`: one entry per module, one per nested property. Include the generated file in the package's `tsconfig.json`.

## Related packages

- [`@spinajs/configuration-common`](../configuration-common/README.md): the contracts this package implements and re-exports, and the `format()` template helper.
- [`@spinajs/di`](../di/README.md): the container every service, source, protocol and schema here is registered in.
- [`@spinajs/configuration-db-source`](../configuration-db-source/README.md): a `ConfigurationSource` that loads rows from a database table, and the `expose` options of `@Config`.
- [`@spinajs/configuration-fs-protocol`](../configuration-fs-protocol/README.md): the `fs-path://` protocol.
- [`@spinajs/configuration-aws-secretmanager-protocol`](../configuration-aws-secretmanager-protocol/README.md): AWS Secrets Manager and Parameter Store protocols.
- [`@spinajs/configuration-http`](../configuration-http/README.md): HTTP endpoints to read and edit exposed configuration.
- [`@spinajs/validation`](../validation/README.md): the general-purpose validator; configuration schemas use their own Ajv instance, described in [Schema validation](06-schema-validation.md).
