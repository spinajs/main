# Configuration sources

A `ConfigurationSource` supplies one slice of configuration: files, a database, environment variables, an in-memory object. `Configuration` loads every registered source in `Order` and deep-merges the results, so a later source overrides an earlier one. `StaticConfigurationSource()` builds a source from a plain object without writing a class.

```ts
abstract class ConfigurationSource {
  abstract get Order(): number;                                    // lower loads first
  abstract Load(configuration: Configuration): Promise<IConfigLike>;
}

function StaticConfigurationSource(cfg: object | (() => object), order = 0): Class<ConfigurationSource>;
```

## How it works

This is the flow in `FrameworkConfiguration` (`@spinajs/configuration`).

1. `FrameworkConfiguration.resolve()` throws `InvalidOperation('No configuration sources configured...')` when nothing is registered under `ConfigurationSource`.
2. `loadSources()` calls `container.resolve(Array.ofType(ConfigurationSource), [RunApp, CustomConfigPaths, AppBaseDir, Env])`. Each source class is created once, with those four values as constructor arguments.
3. The sources are sorted by `Order`, ascending. Equal orders keep registration order.
4. `load()` calls `await source.Load(this)` on each source in turn and merges the result into the config with `_.mergeWith(..., mergeArrays)`. A source can read what earlier sources loaded through `configuration.get()`.
5. `mergeSource(SourceClass)` resolves one more source after boot and appends it to the list; its values are merged by the next `load()`.

`BrowserFrameworkConfiguration` follows the same steps without constructor arguments and without the "no sources" check.

## Shipped sources

| Source | Package | `Order` | Loads |
| --- | --- | --- | --- |
| `JobGrantSource` | `@spinajs/authz-queue/jobs` | `0` | a fixed `authz.rbac` grant (`job:read` on owned jobs) |
| `StaticConfigurationSource(cfg)` | this package | `0` by default | the object or the factory's result |
| `JsFileSource` | `@spinajs/configuration` | `1` | `*.js` / `*.cjs` config files, then `*.<env>.js` overrides |
| `JsonFileSource` | `@spinajs/configuration` | `1` | `*.json` config files, then `*.<env>.json` overrides |
| `ConfiguratioDbSource` | `@spinajs/configuration-db-source` | `999` | exposed entries from the `configuration` table, using the DB credentials loaded before it |

`<env>` is [`normalizeEnvironment()`](07-environment-names.md) of `APP_ENV`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ConfigurationSource` | `ConfigurationSource`, collected with `Array.ofType`; singleton in the container that owns the `Configuration` | `JsFileSource`, `JsonFileSource` | the table above | **add**: `@Injectable(ConfigurationSource)` on a subclass, imported before `Configuration` resolves. **extend**: subclass `BaseFileSource` (`@spinajs/configuration`) or a shipped source. **remove**: `DI.unregister(JsonFileSource)`. |
| `StaticConfigurationSource()` | a factory function; its product is registered with `DI.register(...).as(ConfigurationSource)` | none | none | call it per object; each call returns a new, uniquely named class |

### When to register

- Register before the first `DI.resolve(Configuration)`. Sources are collected once, in `resolve()`.
- After boot, use `configuration.mergeSource(MySource)` and then `configuration.load()`.
- The registry deduplicates by class name, so two source classes with the same `name` collapse into one. `StaticConfigurationSource()` names each product `StaticConfigurationSource0`, `StaticConfigurationSource1`, ... for that reason.

### Constructor arguments

`FrameworkConfiguration` passes four positional arguments to every source constructor:

| Position | Value |
| --- | --- |
| 1 | `RunApp`: app name (`--app`) |
| 2 | `CustomConfigPaths`: extra config directories (`ConfigurationOptions.cfgCustomPaths`) |
| 3 | `AppBaseDir`: apps base directory (`--apppath`) |
| 4 | `Env`: the `--env` flag or `APP_ENV`, not normalized |

A source that needs none of them can omit the constructor.

### `ConfigurationSource`: custom implementation

Load settings from double-underscore environment variables (`APP__HTTP__PORT=8080` becomes `http.port = 8080`), after the files so they override them.

```ts sample
import { Injectable } from '@spinajs/di';
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration-common';

@Injectable(ConfigurationSource)
export class PrefixedEnvSource extends ConfigurationSource {
  constructor(
    protected runApp?: string,
    protected customPaths?: string[],
    protected appBaseDir?: string,
    protected env?: string,
  ) {
    super();
  }

  // after JsFileSource / JsonFileSource (1), before the database source (999)
  public get Order(): number {
    return 10;
  }

  public Load(configuration: Configuration): Promise<IConfigLike> {
    const prefix = configuration.get<string>('envSource.prefix', 'APP__');
    const result: Record<string, unknown> = {};

    for (const [key, raw] of Object.entries(process.env)) {
      if (!key.startsWith(prefix) || raw === undefined) {
        continue;
      }

      const path = key.slice(prefix.length).toLowerCase().split('__');
      let node = result;
      path.slice(0, -1).forEach((segment) => {
        node = (node[segment] ??= {}) as Record<string, unknown>;
      });
      node[path[path.length - 1]] = /^\d+$/.test(raw) ? Number(raw) : raw;
    }

    return Promise.resolve(result as IConfigLike);
  }
}
```

### Extend a shipped source

Subclass a source to change one decision. `BaseFileSource.getEnvironment()` is documented as an override point; this subclass loads `*.staging.json` for any `APP_ENV` that starts with `staging-`.

```ts sample
import { Injectable } from '@spinajs/di';
import { Configuration, ConfigurationSource, JsonFileSource } from '@spinajs/configuration';

@Injectable(ConfigurationSource)
export class PreviewJsonFileSource extends JsonFileSource {
  protected getEnvironment(config: Configuration): string {
    const env = super.getEnvironment(config);
    return env.startsWith('staging-') ? 'staging' : env;
  }
}
```

Unregister the original so both do not load the same files: `DI.unregister(JsonFileSource)`, before `Configuration` resolves.

## `StaticConfigurationSource()` factory

`StaticConfigurationSource(cfg, order)` returns a new `ConfigurationSource` class whose `Load()` returns `cfg`, or `cfg()` when it is a function. You register the class yourself.

- **Why a factory, not an instance.** Sources are created by DI with fixed constructor arguments, so a config object cannot be passed in. The factory bakes it into a class.
- **Lazy form.** With a function, the object is built on every `load()`, so it can read state that exists only at boot.
- **Platform-free.** It is in the browser entry; it is the usual source for `BrowserFrameworkConfiguration`.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration, ConfigurationSource, StaticConfigurationSource } from '@spinajs/configuration-common';

// defaults first (order 0), runtime overrides last (order 100)
DI.register(StaticConfigurationSource({ http: { port: 8080 }, logger: { level: 'info' } })).as(ConfigurationSource);
DI.register(StaticConfigurationSource(() => ({ http: { port: Number(process.env.PORT ?? 8080) } }), 100)).as(ConfigurationSource);

export async function port() {
  const cfg = await DI.resolve(Configuration);
  return cfg.get<number>('http.port');
}
```

## Important behaviour

- **Arrays replace.** `FrameworkConfiguration` merges a source's result with `mergeConfig(tree, result, 'replace')`: an array from a later source replaces the earlier one, except the composed arrays such as `system.dirs.*`, which concatenate. To add to a list, `merge()` it in code. See [Arrays](../configuration/01-configuration-service.md#arrays).
- **A source can read earlier sources.** `Load(configuration)` runs after every lower `Order` source has merged, which is how the database source finds its connection settings.
- **A source that throws fails the boot.** `load()` does not catch `Load()` errors; the file sources catch per-file errors themselves and return `{}`.
- **`mergeSource()` does not merge in `FrameworkConfiguration`.** It appends the source; the values arrive with the next `load()`.
- **Sources are not re-sorted after `mergeSource()`.** An appended source always loads last on later `load()` calls, whatever its `Order`.
- **The eager `StaticConfigurationSource` returns the same object on every `load()`.** Changes you make to that object later show up on the next `load()`. Use the function form when each load needs a fresh value.

## Best practices

- Pick `Order` relative to the shipped sources: below `1` for defaults the files may override, between `1` and `999` for overrides of files, above `999` only when you need database values.
- Return `{}` (as `IConfigLike`) when the source has nothing, rather than `undefined`.
- Use `StaticConfigurationSource` in tests and browser apps instead of writing JSON files.

## Patterns and antipatterns

```ts
// Don't: registered after boot, never loaded
await DI.resolve(Configuration);
DI.register(StaticConfigurationSource({ feature: { beta: true } })).as(ConfigurationSource);

// Do: register first, or merge it explicitly after boot
const cfg = await DI.resolve(Configuration);
await cfg.mergeSource(StaticConfigurationSource({ feature: { beta: true } }));
await cfg.load();
```

## Examples

### Load tenant settings from a secrets file mounted by the platform

```ts sample
import { readFile } from 'node:fs/promises';
import { Injectable } from '@spinajs/di';
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration-common';

@Injectable(ConfigurationSource)
export class MountedTenantSource extends ConfigurationSource {
  public get Order(): number {
    return 5;
  }

  public async Load(configuration: Configuration): Promise<IConfigLike> {
    const file = configuration.get<string>('tenant.settingsFile', '/etc/app/tenant.json');
    try {
      return { tenant: JSON.parse(await readFile(file, 'utf8')) } as unknown as IConfigLike;
    } catch {
      return {} as IConfigLike;
    }
  }
}
```

## Related

- [The `Configuration` service](04-configuration-service.md): the service that collects and merges sources.
- [Environment names](07-environment-names.md): how `*.dev.json` and `*.prod.json` are chosen.
- [`@spinajs/configuration`](../configuration/README.md): `JsFileSource`, `JsonFileSource`, `BaseFileSource`.
- [`@spinajs/configuration-db-source`](../configuration-db-source/README.md): the order-`999` database source.
