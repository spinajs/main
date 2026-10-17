# Injecting config values

`@Config(path, options)` turns a class property into a live view of one config value. `cfg(path)` reads a value from anywhere, and `_cfg(path)` returns a function that reads it later. In an app with child containers, `@Config` reads the configuration of the container that built the instance.

## How it works

`@Config('mailer.fromAddress', { defaultValue })` on a property, when the class is declared:

1. registers `{ path, options }` in the root container as a `__configuration_property__` value, for modules that list config entries (`@spinajs/configuration-db-source`);
2. adds a property dependency that injects the resolving `Container` under `__configurationContainer__` (`CONFIGURATION_CONTAINER_KEY`), so the class still resolves synchronously;
3. replaces the property with a getter on the prototype.

On every read of the property:

1. the getter takes the injected container, or the root container for an instance built with `new`;
2. it finds the nearest container in that lineage that registers a `Configuration` and takes its resolved instance;
3. it returns `configuration.get(path, options.defaultValue)`.

When that configuration is not resolved yet, the read throws `InvalidOperation('Cannot read configuration path <path>: the Configuration of the container is not resolved')`.

`cfg(path, defaultValue?)`:

1. takes the resolved `Configuration` of the root container, or throws `ResolveException` when none is resolved;
2. throws `InvalidArgument` for an empty `path`;
3. returns `get(path, defaultValue)`, and throws `InvalidArgument` when that is `null` or `undefined`. `0`, `''`, `false`, `[]` and `{}` are valid values.

`_cfg(path, defaultValue?)` returns `() => cfg(path, defaultValue)`.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Config(path, options?)` | property | `defaultValue?: unknown` returned when the value is `undefined`; `required?: boolean` stored for admin UIs, **not enforced**; `expose`, `exposeOptions` added by `@spinajs/configuration-db-source` | Replaces the property with a getter that reads `path` from the configuration of the building container on every access. |

## Configuration

`@Config` reads any key. The option keys `expose` and `exposeOptions` come from a `declare module '@spinajs/configuration-common'` augmentation of `IConfigEntryOptions` in `@spinajs/configuration-db-source`; they are typed only when that package is imported. See its docs for the database columns they fill.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Config entry registry | `__configuration_property__` values in the root container, one `{ path, options }` per `@Config` | none | none | Listen with `DI.on('di.registered.__configuration_property__', handler)` and read the existing ones with `DI.get(Array.ofType('__configuration_property__'))`. `@spinajs/configuration-db-source` does this to persist and watch entries. |
| Entry options | `IConfigEntryOptions` interface in `@spinajs/configuration-common` | `{ defaultValue, required }` | `expose`, `exposeOptions` (`@spinajs/configuration-db-source`) | Augment it with `declare module '@spinajs/configuration-common'`. |
| Container key | `CONFIGURATION_CONTAINER_KEY` (`'__configurationContainer__'`), an instance property | set by DI | none | Define it on an instance built with `new` to make its `@Config` properties read another container. |

### Config entry registry: custom listener

List every `@Config` entry with an admin label, for a settings screen. Extend `IConfigEntryOptions` for the extra option and collect the entries as they are declared.

```ts sample
import { DI } from '@spinajs/di';
import { Config, IConfigEntryOptions } from '@spinajs/configuration';

declare module '@spinajs/configuration-common' {
  interface IConfigEntryOptions {
    adminLabel?: string;
  }
}

interface ConfigEntry {
  path: string;
  options?: IConfigEntryOptions;
}

const settings = new Map<string, string>();
const collect = (entry: ConfigEntry) => {
  if (entry.options?.adminLabel) settings.set(entry.path, entry.options.adminLabel);
};

DI.on('di.registered.__configuration_property__', collect);
(DI.get(Array.ofType<ConfigEntry>('__configuration_property__')) ?? []).forEach(collect);

export class UploadService {
  @Config('uploads.maxSizeMb', { defaultValue: 10, adminLabel: 'Max upload size (MB)' })
  protected MaxSizeMb: number;
}

console.log([...settings.entries()]);
```

### Container key: read another container

An instance built with `new` reads the root configuration. Define `CONFIGURATION_CONTAINER_KEY` on it to read a child container's configuration instead; tests use this for objects they build by hand.

```ts sample
import { DI, IContainer } from '@spinajs/di';
import {
  Config,
  Configuration,
  CONFIGURATION_CONTAINER_KEY,
  ConfigurationSource,
  FrameworkConfiguration,
  StaticConfigurationSource,
} from '@spinajs/configuration';

class ReportJob {
  @Config('reports.batchSize', { defaultValue: 100 })
  public BatchSize: number;
}

function readingFrom<T extends object>(instance: T, container: IContainer): T {
  Object.defineProperty(instance, CONFIGURATION_CONTAINER_KEY, { value: container, configurable: true, writable: true });
  return instance;
}

async function main() {
  const tenant = DI.child();
  tenant.register(StaticConfigurationSource({ reports: { batchSize: 500 } })).as(ConfigurationSource);
  tenant.register(class TenantConfiguration extends FrameworkConfiguration {}).as(Configuration);
  await tenant.resolve(Configuration);

  const job = readingFrom(new ReportJob(), tenant);
  console.log(job.BatchSize); // 500
}

void main();
```

## Important behaviour

- The property is a live view: after `set()`, `load()` or a database watch update, the next read returns the new value.
- `defaultValue` is a fallback for `undefined` only. A `null` from a source is returned as `null`.
- `required` is not enforced. Use a [schema](06-schema-validation.md) with `required`.
- Read `@Config` properties in `resolve()` or later. In the constructor and in field initializers, the container is not injected yet, so the root configuration is read.
- A class with `@Config` resolves synchronously, even before the configuration boots; only reading the property needs the configuration.
- In a child container with its own `Configuration`, a per-child service (`@PerChildInstance`) reads the child's values; a root singleton reads the root's values, also when resolved through the child. A child without its own `Configuration` reads the nearest ancestor's.
- A configuration registered as a factory is read by calling the factory: it must return an already-resolved instance, or the read throws.
- `cfg()` and `_cfg()` always read the **root** container's configuration, never a child's.
- The getter is non-configurable. Initializing the field (`= 5`) either throws on assignment or shadows the getter, depending on `useDefineForClassFields`. Use `defaultValue`.
- Reading a path inside a module a late schema refused throws `InvalidConfiguration`.

## Best practices

- Prefer `@Config` over `cfg()` in services: it follows the container and reloads.
- Give `@Config` the full dotted path and keep one source of defaults: the schema.
- Use `cfg()` in plain functions and module-level helpers, after the configuration has resolved.

## Patterns and antipatterns

```ts
// Don't: a field initializer breaks the getter
@Config('reports.batchSize')
public BatchSize = 100;

// Do
@Config('reports.batchSize', { defaultValue: 100 })
public BatchSize: number;
```

```ts
// Don't: in the constructor the container is not injected; this reads the root configuration
constructor() {
  super();
  this.Limit = this.BatchSize * 2;
}

// Do
public async resolve() {
  this.Limit = this.BatchSize * 2;
}
```

## Examples

### Read pool settings in a service and a helper

```ts sample
import { AsyncService, DI, Injectable } from '@spinajs/di';
import { cfg, Config, Configuration } from '@spinajs/configuration';

@Injectable()
export class ExportService extends AsyncService {
  @Config('exports.concurrency', { defaultValue: 4 })
  protected Concurrency: number;

  protected Pool: number[] = [];

  public async resolve(): Promise<void> {
    await super.resolve();
    this.Pool = Array.from({ length: this.Concurrency }, (_, i) => i);
  }
}

export function exportDir(): string {
  return cfg<string>('exports.dir', './exports');
}

async function main() {
  await DI.resolve(Configuration);
  const service = await DI.resolve(ExportService);
  console.log(exportDir(), service);
}

void main();
```

## Related

- [Config-selected services](08-config-selected-services.md): inject a service named in config instead of a value.
- [Replacing the configuration service](09-replacing-the-configuration-service.md#one-configuration-per-child-container): one configuration per child container.
- [`@spinajs/configuration-db-source`](../configuration-db-source/README.md): `expose` and `watch` for `@Config` entries.
