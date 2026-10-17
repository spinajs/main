# Replacing the configuration service

`Configuration` is an abstract DI token; `FrameworkConfiguration` is only its default. Subclass it to feed values from code (tests, worker processes), give each child container its own configuration (tenants, test scenarios), or implement the contract from scratch for another runtime. Everything that reads config (`@Config`, `cfg()`, the config-selected service decorators, other packages) works with any of them.

## How it works

1. **Registration.** `FrameworkConfiguration` registers itself with `@Injectable(Configuration)` when `@spinajs/configuration` is imported. DI resolves the **last** registration of a token, so `DI.register(MyConfiguration).as(Configuration)` after that import replaces it.
2. **Resolution.** `DI.resolve(Configuration, [options])` builds the class with `options` and awaits its `resolve()` (it is an `AsyncService`). The instance is cached per container, as a singleton.
3. **Lookup by readers.** `@Config`, `@AutoinjectService`, `@AutoinjectNamedService(s)` and `registerConfigurationSchema()` walk from the reading container to the nearest container that **registers** a `Configuration`, and use that container's instance.
4. **Child containers.** A child that registers its own `Configuration` gets a separate instance with its own sources and schemas. A child that registers none reads its nearest ancestor's.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Configuration | `Configuration` (abstract, `AsyncService`), singleton per registering container | `FrameworkConfiguration` | `BrowserFrameworkConfiguration` ([browser](10-browser-configuration.md)), `ElectronRendererConfiguration` (`@spinajs/electron`, forwards `get()` over IPC and throws for the rest) | Subclass `FrameworkConfiguration` and override its hooks, or extend `Configuration` and implement the contract. Register with `DI.register(Impl).as(Configuration)` before the first resolve, in the root or in a child container. |

The `Configuration` contract:

| Member | Must |
| --- | --- |
| `get RootConfig(): IConfigLike` | Return the whole tree. |
| `get<T>(path, defaultValue?)` | Return the value at `path` (`string` or `string[]`), `defaultValue` when it is `undefined`. |
| `set(path, value)` | Store `value` at `path`. |
| `merge(path, value)` | Deep-merge `value` into `path`. |
| `load()` | (Re)build the tree. |
| `mergeSource(sourceClass)` | Load one more `ConfigurationSource`. |
| `onLoad()` (protected) | Return extra values to merge; may return `null`. |
| `resolve()` | From `AsyncService`; build the tree here, before readers use it. |
| `RunApp`, `AppBaseDir` | App name and apps directory; empty strings when not used. |

What each choice keeps:

| Feature | `FrameworkConfiguration` subclass | Own `Configuration` implementation |
| --- | --- | --- |
| File sources, other `ConfigurationSource`s | yes, unless `loadSources()` is overridden | only what you load |
| Protocols (`fs-path://`, ...) | yes | no |
| Schema validation, defaults, late schemas | yes | no: `registerConfigurationSchema()` stores the schema and checks nothing |
| `@Config`, `cfg()`, config-selected services | yes | yes |

### FrameworkConfiguration: custom subclass

The usual subclass for tests and workers skips the files and returns values from code. Validation and protocols still run, so a test sees the same defaults and errors as the app.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';

export function configurationOf(values: Record<string, unknown>, env = 'test') {
  const json = JSON.stringify(values);
  return class SpecConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = env;
    }

    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  };
}

async function main() {
  DI.register(configurationOf({ mailer: { fromAddress: 'qa@example.com' } })).as(Configuration);

  try {
    const configuration = await DI.resolve(Configuration);
    console.log(configuration.get<string>('mailer.fromAddress'));
  } catch (err) {
    if (err instanceof InvalidConfiguration) console.error(err.violations);
    throw err;
  }
}

void main();
```

`JSON.stringify` and `JSON.parse` give each instance a fresh copy, because validation writes defaults into the tree.

### Configuration: own implementation

Implement the contract when the values come from somewhere `FrameworkConfiguration` cannot reach, or when its Node dependencies are unwelcome. This one is backed by environment variables with a prefix: `APP__HTTP__PORT=8080` becomes `http.port`.

```ts sample
import _ from 'lodash';
import { Class, DI } from '@spinajs/di';
import { Config, Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration';

export class EnvConfiguration extends Configuration {
  protected Tree: Record<string, unknown> = {};

  constructor(protected Prefix = 'APP__') {
    super();
    this.RunApp = '';
    this.AppBaseDir = '';
  }

  public get RootConfig(): IConfigLike {
    return this.Tree as IConfigLike;
  }

  public async resolve(): Promise<void> {
    await this.load();
    await super.resolve();
  }

  public get<T>(path: string[] | string, defaultValue?: T): T {
    return _.get(this.Tree, path, defaultValue) as T;
  }

  public set(path: string[] | string, value: unknown): void {
    _.set(this.Tree, path, value);
  }

  public merge(path: string[] | string, value: unknown): void {
    _.set(this.Tree, path, _.merge(this.get(path, {}), value));
  }

  public async load(): Promise<void> {
    this.Tree = {};
    for (const [key, raw] of Object.entries(process.env)) {
      if (!key.startsWith(this.Prefix) || raw === undefined) continue;
      const path = key.slice(this.Prefix.length).toLowerCase().split('__');
      const asNumber = Number(raw);
      this.set(path, raw !== '' && !Number.isNaN(asNumber) ? asNumber : raw);
    }
    _.merge(this.Tree, this.onLoad());
  }

  public async mergeSource(source: Class<ConfigurationSource>): Promise<void> {
    const instance = (await DI.resolve(source)) as ConfigurationSource;
    _.merge(this.Tree, await instance.Load(this));
  }

  protected onLoad(): unknown {
    return {};
  }
}

class HttpServer {
  @Config('http.port', { defaultValue: 3000 })
  public Port: number;
}

async function main() {
  DI.register(EnvConfiguration).as(Configuration);
  await DI.resolve(Configuration);
  console.log(DI.resolve(HttpServer).Port);
}

void main();
```

### One configuration per child container

Register a configuration class and its sources in a child container to give a tenant, a test scenario or an embedded app its own values. Services that are per child (`@PerChildInstance`) and resolved in that child read them; root singletons keep reading the root configuration.

```ts sample
import { DI, PerChildInstance } from '@spinajs/di';
import { Config, Configuration, ConfigurationSource, FrameworkConfiguration, StaticConfigurationSource } from '@spinajs/configuration';

@PerChildInstance()
class BrandingService {
  @Config('branding.primaryColor', { defaultValue: '#000000' })
  public PrimaryColor: string;
}

async function tenantContainer(values: Record<string, unknown>) {
  const child = DI.child();
  child.register(StaticConfigurationSource(values)).as(ConfigurationSource);
  child.register(class TenantConfiguration extends FrameworkConfiguration {}).as(Configuration);
  child.register(BrandingService).asSelf();
  await child.resolve(Configuration);
  return child;
}

async function main() {
  const acme = await tenantContainer({ branding: { primaryColor: '#d02020' } });
  const globex = await tenantContainer({ branding: { primaryColor: '#2040d0' } });

  console.log(acme.resolve(BrandingService).PrimaryColor, globex.resolve(BrandingService).PrimaryColor);
}

void main();
```

## Important behaviour

- Register the replacement **before** the first `DI.resolve(Configuration)` in that container; a resolved configuration stays cached until `DI.clearCache()`.
- A child that registers any `ConfigurationSource` uses only its own sources; without its own it uses the nearest ancestor's (the root's file sources). Register sources in the child to keep files out.
- Readers find the configuration of the nearest container that **registers** one, and never fall back to an ancestor's. A child that registers a configuration but has not resolved it makes `@Config` reads throw `InvalidOperation`.
- `@AutoinjectNamedService(s)` resolve that configuration first; `@Config` and `@AutoinjectService` need it resolved.
- A configuration registered as a factory (`child.register(() => instance).as(Configuration)`) is read by calling the factory on every read: return an already-resolved instance from it.
- `cfg()`, `_cfg()`, `service()` and `_service()` always use the root configuration.
- Protocols are resolved in each configuration's own container, from the nearest container that registers any.
- Schemas registered in an ancestor apply to a child's `FrameworkConfiguration`; schemas registered in the child do not apply to the parent.
- `FrameworkConfiguration` reads `--app`, `--apppath` and `--env` from `process.argv` in its constructor. A subclass for tests sets `this.Env` after `super()` to stay independent of the command line.

## Best practices

- In tests, build one configuration class per scenario (`configurationOf(values)`) in a child container, and `dispose()` the child after the test.
- Keep the `FrameworkConfiguration` subclass thin: override `onLoad()` and `loadSources()`, and let validation and protocols run.
- Implement `Configuration` from scratch only for runtimes without `fs` or `ajv`; you give up schemas, defaults and protocols.

## Patterns and antipatterns

```ts
// Don't: one shared object; validation writes defaults into it and leaks them between tests
const values = { mailer: {} };
class SpecConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return values;
  }
}

// Do: a fresh copy per load
const json = JSON.stringify({ mailer: {} });
class SpecConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return JSON.parse(json) as unknown;
  }
}
```

## Examples

### Worker process with config sent by the parent

A worker receives the parent's config tree and must not read files of its own working directory.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

export async function bootWorker(config: Record<string, unknown>) {
  class WorkerConfiguration extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return config;
    }
  }

  DI.register(WorkerConfiguration).as(Configuration);
  return DI.resolve(Configuration);
}
```

## Related

- [Configuration service](01-configuration-service.md): what `FrameworkConfiguration` does in `resolve()` and `load()`.
- [Injecting config values](07-injecting-config-values.md): how `@Config` finds the configuration.
- [Browser configuration](10-browser-configuration.md): the shipped implementation without Node dependencies.
- [`@spinajs/di`](../di/README.md): child containers and lifetimes.
