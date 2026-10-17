# Custom configuration sources

A configuration source returns part of the configuration tree. Every class registered under `ConfigurationSource` is loaded at boot, in `Order`, and merged over the sources before it. Add one to read config from a database, a remote service, a vault or a file format the framework does not read.

## How it works

1. **Register.** `@Injectable(ConfigurationSource)` on the class, or `DI.register(MySource).as(ConfigurationSource)`, before the configuration resolves.
2. **Resolve.** `FrameworkConfiguration.loadSources()` resolves `Array.ofType(ConfigurationSource)` in the configuration's container, passing `[RunApp, CustomConfigPaths, AppBaseDir, Env]` to each constructor, and sorts the instances by `Order`, ascending.
3. **Load.** `load()` calls `await source.Load(configuration)` on each, in order. `configuration` holds everything merged so far, so a source can read values earlier sources loaded (credentials, a connection name).
4. **Merge.** A returned object is deep-merged into the tree; arrays are concatenated. A falsy result is skipped.
5. **Then** `onLoad()`, the `__configuration__` values and the protocols run (see [Configuration service](01-configuration-service.md#how-it-works)).

An exception thrown by `Load()` rejects the configuration's resolve.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Configuration source | `ConfigurationSource` (abstract), resolved as `Array.ofType`, singleton by default | `JsFileSource`, `JsonFileSource` (`Order` 1) | `ConfiguratioDbSource` (`@spinajs/configuration-db-source`, `Order` 999), `StaticConfigurationSource(cfg, order)` | Extend `ConfigurationSource`, implement `Order` and `Load()`, register under `ConfigurationSource`. Extend `BaseFileSource` for a file format (see [Config files](03-config-files.md#basefilesource-custom-file-format)). |
| In-memory source | factory `StaticConfigurationSource(cfg, order = 0)` returns a source class | none | none | Register its result under `ConfigurationSource`. `cfg` is an object or a function that returns one, called on each `load()`. |
| Code-only config | `__configuration__` DI values, resolved as `Array.ofType` | none | none | `DI.register(obj).asValue('__configuration__')`. |

The contract, from `@spinajs/configuration-common`:

| Member | Meaning |
| --- | --- |
| `abstract get Order(): number` | Load position. Lower loads first; a higher `Order` overrides scalars from a lower one. |
| `abstract Load(configuration: Configuration): Promise<IConfigLike>` | Returns the partial tree to merge. |

Choose `Order` by what the source needs and what it must override:

| `Order` | Use |
| --- | --- |
| `0` | Defaults that files override (the `StaticConfigurationSource` default). |
| `1` | The shipped file sources. |
| `2` to `998` | Sources that need file values (connection strings) or override files. |
| `999` | `ConfiguratioDbSource`: database rows override everything. |

### Configuration source: custom implementation

Load per-tenant feature flags from an HTTP endpoint whose URL comes from a config file. The source runs after the file sources, reads the URL from the partial tree and returns a `features` section.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration';

@Injectable(ConfigurationSource)
export class RemoteFeatureFlagsSource extends ConfigurationSource {
  public get Order() {
    return 10;
  }

  public async Load(configuration: Configuration): Promise<IConfigLike> {
    const url = configuration.get<string>('features.remoteUrl');
    if (!url) {
      const empty: Record<string, unknown> = {};
      return empty as IConfigLike;
    }

    const response = await fetch(url);
    const flags = (await response.json()) as Record<string, boolean>;
    const result: Record<string, unknown> = { features: { flags } };
    return result as IConfigLike;
  }
}

async function main() {
  // config/features.js: export default { features: { remoteUrl: 'https://flags.internal/tenant-a' } }
  const configuration = await DI.resolve(Configuration);
  console.log(configuration.get<boolean>('features.flags.newCheckout', false));
}

void main();
```

To replace the shipped file sources instead of adding to them, unregister them before the first resolve:

```ts sample
import { DI } from '@spinajs/di';
import { Configuration, ConfigurationSource, JsFileSource, JsonFileSource, StaticConfigurationSource } from '@spinajs/configuration';

async function main() {
  DI.unregister(JsFileSource);
  DI.unregister(JsonFileSource);
  DI.register(StaticConfigurationSource({ http: { port: 3000 } })).as(ConfigurationSource);

  const configuration = await DI.resolve(Configuration);
  console.log(configuration.get<number>('http.port'));
}

void main();
```

### StaticConfigurationSource: in-memory source

`StaticConfigurationSource(cfg, order)` builds a `ConfigurationSource` subclass that returns `cfg`, or `cfg()` when it is a function. Each call gives a class with a unique name (`StaticConfigurationSource0`, `StaticConfigurationSource1`, ...), so several can be registered side by side.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration, ConfigurationSource, StaticConfigurationSource } from '@spinajs/configuration';

async function main() {
  // defaults, overridden by config files (Order 1)
  DI.register(StaticConfigurationSource({ http: { port: 8080, host: '0.0.0.0' } }, 0)).as(ConfigurationSource);

  // computed on every load(), wins over files
  DI.register(StaticConfigurationSource(() => ({ build: { commit: process.env.GIT_SHA ?? 'local' } }), 50)).as(ConfigurationSource);

  const configuration = await DI.resolve(Configuration);
  console.log(configuration.get<string>('build.commit'));
}

void main();
```

### The `__configuration__` value

A module that has config but no files (a bundled build, a plugin) registers an object as a `__configuration__` value. `load()` merges each of its top-level keys after `onLoad()`.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

async function main() {
  // `http` must already be defined by a source, here the config file of @spinajs/http
  DI.register({ http: { middlewares: ['request-id'] } }).asValue('__configuration__');

  const configuration = await DI.resolve(Configuration);
  console.log(configuration.get<string[]>('http.middlewares'));
}

void main();
```

## Important behaviour

- `FrameworkConfiguration` throws `InvalidOperation` when no `ConfigurationSource` is registered in its container or an ancestor.
- Sources are resolved in the configuration's own container. A container that registers any `ConfigurationSource` uses only its own sources; one that registers none uses those of the nearest ancestor that does. The same holds for `__configuration__` values.
- Two sources with the same `Order` keep their registration order.
- A source is a singleton unless decorated otherwise; it receives the constructor arguments once. `Load()` runs on every `load()`, so a source that caches must refresh itself there.
- A source must not `await DI.resolve(Configuration)` or use the config-selected service helpers: the configuration is still resolving, and the resolve would wait on itself. Use the `configuration` argument.
- In `FrameworkConfiguration`, a `__configuration__` key that no source defines is dropped (it is merged with `merge()`, which writes nothing at a missing path). Use a `StaticConfigurationSource` for new top-level keys. `BrowserFrameworkConfiguration` keeps them.
- `Configuration.mergeSource(SourceClass)` adds a source after boot but does not merge it into the current tree; call `load()` after it.

## Best practices

- Read what your source needs from the `configuration` argument, and give it an `Order` above the sources that provide it.
- Return only the sections your source owns; the deep merge leaves the rest.
- Register a [schema](06-schema-validation.md) for the sections your source returns; remote values are validated like file values.
- Log and return `{}` for an optional remote source that is unreachable, so the app still boots; throw when the values are required.

## Patterns and antipatterns

```ts
// Don't: the configuration is still resolving; this waits on itself
public async Load(): Promise<IConfigLike> {
  const configuration = await DI.resolve(Configuration);
  return load(configuration.get('vault.url'));
}

// Do
public async Load(configuration: Configuration): Promise<IConfigLike> {
  return load(configuration.get('vault.url'));
}
```

## Examples

### Load secrets from a vault with credentials from files

```ts sample
import { Injectable } from '@spinajs/di';
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration';

interface VaultClient {
  read(path: string): Promise<Record<string, string>>;
}

declare function connectVault(url: string, token: string): VaultClient;

@Injectable(ConfigurationSource)
export class VaultSource extends ConfigurationSource {
  public get Order() {
    return 20;
  }

  public async Load(configuration: Configuration): Promise<IConfigLike> {
    const url = configuration.get<string>('vault.url');
    const token = configuration.get<string>('process.env.VAULT_TOKEN');
    const vault = connectVault(url, token);

    const db = await vault.read('secret/data/db');
    const result: Record<string, unknown> = { db: { Password: db.password } };
    return result as IConfigLike;
  }
}
```

## Related

- [Config files](03-config-files.md): the shipped sources and `BaseFileSource`.
- [Config var protocols](05-config-var-protocols.md): resolve single values (`aws-secrets://db`) instead of whole sections.
- [`@spinajs/configuration-db-source`](../configuration-db-source/README.md): a database-backed source with runtime editing.
- [`@spinajs/configuration-common`](../configuration-common/README.md): the `ConfigurationSource` contract and `StaticConfigurationSource`.
