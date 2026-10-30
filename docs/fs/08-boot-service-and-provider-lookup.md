# Boot service and provider lookup

Two services hold the package together: `fsService` creates the providers, and the `'__file_provider__'` factory registered by `FsBootstrapper` finds one by name. Replace or extend them when you need different boot rules or a different lookup, eg. stricter validation or provider aliases.

## How it works

1. `FsBootstrapper.bootstrap()` registers a factory `(container, name) => fs` under `'__file_provider__'`.
2. `fsService.resolve()` creates every provider and registers each one with `DI.register(instance).asMapValue('__file_provider_instance__', name)`. The flow is in [Providers and configuration](01-providers-and-configuration.md#how-it-works).
3. `getFs(name)` calls `DI.resolve('__file_provider__', [name])`. The factory reads the `'__file_provider_instance__'` map and returns the entry for `name`.
4. The factory throws `ResolveException` when the map does not exist yet (`fsService` not resolved) or has no entry for `name`.

## Configuration

`fsService` reads `fs.defaultProvider` and `fs.providers`. See [Providers and configuration](01-providers-and-configuration.md#configuration).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `fsService` | `fsService` class, singleton; an `AsyncService`, so `DI.resolve(fsService)` returns a promise | `fsService` | none | Subclass it and `DI.register(MySubclass).as(fsService)` before the first `DI.resolve(fsService)`. Override `resolve()` (call `super.resolve()`). |
| `FsBootstrapper` | `Bootstrapper`, through `@Injectable(Bootstrapper)` | `FsBootstrapper` | none | Leave it; replace the factory it registers. |
| Provider lookup | `'__file_provider__'`, a factory; the last registered factory wins | name lookup in `'__file_provider_instance__'` | none | `DI.register(factory).as('__file_provider__')` after `FsBootstrapper.bootstrap()` ran. |
| Provider map | `'__file_provider_instance__'`, a `Map<string, fs>` built with `asMapValue()` | filled by `fsService` | none | Read it with `DI.get<Map<string, fs>>('__file_provider_instance__')`, eg. to list providers. Do not write to it outside `fsService`. `fsService.dispose()` removes the names it published, unless a newer `fsService` published the name again or another provider now sits under it. |

### `fsService`: custom implementation

Extend `fsService` to add boot rules. This one fails the boot when `fs.defaultProvider` names a provider that does not exist, which the default service does not check.

```ts sample
import { DI } from '@spinajs/di';
import { InvalidConfiguration } from '@spinajs/configuration';
import { fs, fsService } from '@spinajs/fs';

export class StrictFsService extends fsService {
  public async resolve(): Promise<void> {
    await super.resolve();

    const providers = DI.get<Map<string, fs>>('__file_provider_instance__');
    if (!providers?.has(this.Config.defaultProvider)) {
      throw new InvalidConfiguration(`fs.defaultProvider '${this.Config.defaultProvider}' is not one of the configured fs.providers`);
    }

    this.Logger.info({ count: providers.size }, 'Validated ${count} file providers');
  }
}

export async function bootFileSystems(): Promise<void> {
  DI.register(StrictFsService).as(fsService);
  await DI.resolve(fsService);
}
```

The [CLI commands](11-cli-commands.md) and other packages resolve `fsService` by its class, so they get your subclass too.

### Provider lookup factory

Replace the factory to change how a name maps to a provider. This one keeps old provider names working after a rename, so stored `fs://` URIs and `@FileSystem()` names stay valid.

```ts sample
import { DI, IContainer, ResolveException } from '@spinajs/di';
import { fs } from '@spinajs/fs';

const PROVIDER_ALIASES: Record<string, string> = {
  'user-uploads': 'uploads',
  'pdf-exports': 'exports',
};

// call after every Bootstrapper ran, so it is registered after FsBootstrapper's factory
export function registerProviderAliases(): void {
  DI.register((_container: IContainer, name: string) => {
    const providers = DI.get<Map<string, fs>>('__file_provider_instance__');
    const instance = providers?.get(PROVIDER_ALIASES[name] ?? name);

    if (!instance) {
      throw new ResolveException(`File provider ${name} not registered`);
    }

    return instance;
  }).as('__file_provider__');
}
```

### Reading a published provider

`FILE_PROVIDER_INSTANCES` is the provider map key (`'__file_provider_instance__'`). `publishedFs(name, container = DI.RootContainer)` returns the provider published under `name`, or `undefined` when there is none or `fsService` has not resolved. Unlike `getFs()`, it does not go through the `'__file_provider__'` factory and never throws.

```ts sample
import { DI } from '@spinajs/di';
import { fs, FILE_PROVIDER_INSTANCES, publishedFs } from '@spinajs/fs';

const uploads = publishedFs('uploads');
const all = DI.get<Map<string, fs>>(FILE_PROVIDER_INSTANCES);
```

## Important behaviour

- `fsService` is not decorated with `@Injectable`. It is created on the first `DI.resolve(fsService)`, which is the only boot trigger.
- `fsService` registers each provider in the map as soon as it is created, so a provider that runs `getFs()` in its own `resolve()` finds the ones created before it.
- The map is a DI value, so `DI.clearCache()` keeps it. `fsService.dispose()` (also through `DI.dispose()`) removes the names it published, so `getFs()` no longer serves them; a name a newer `fsService` published again stays, and entries others added with `asMapValue()` stay.
- `@FileSystem()` reads the provider through `getFs()` on every property access, so a replaced factory applies there too.
- `getFs()` returns an `fs` instance unchanged without calling the factory.

## Best practices

- Throw `ResolveException` from a custom factory for an unknown name, like the default one. Code that catches it keeps working.
- Call `super.resolve()` first in a `fsService` subclass: providers exist only after it.

## Related

- [Providers and configuration](01-providers-and-configuration.md): the boot flow and lookup APIs.
- [Middlewares](07-middlewares.md): run around every action of the providers `fsService` creates.
- [CLI commands](11-cli-commands.md): resolve `fsService` on their own.
