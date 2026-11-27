# Boot service and provider lookup

Two services hold the package together: `fsService` creates the providers, and the `'__file_provider__'` factory registered by `FsBootstrapper` finds one by name. Replace or extend them when you need different boot rules or a different lookup, eg. stricter validation or provider aliases.

## How it works

1. `FsBootstrapper.bootstrap()` registers a factory `(container, name) => fs` under `'__file_provider__'`.
2. `fsService.resolve()` creates every provider and registers each one with `DI.register(instance).asMapValue('__file_provider_instance__', name)`. The flow is in [Providers and configuration](01-providers-and-configuration.md#how-it-works).
3. `getFs(name)` calls `DI.resolve('__file_provider__', [name])`. The factory reads the `'__file_provider_instance__'` map and returns `layeredFs(entry)`: the entry for `name` as the registered [provider layers](#provider-layers) hand it out.
4. The factory throws `ResolveException` when the map does not exist yet (`fsService` not resolved) or has no entry for `name`.

## Configuration

`fsService` reads `fs.defaultProvider` and `fs.providers`. See [Providers and configuration](01-providers-and-configuration.md#configuration).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `fsService` | `fsService` class, singleton; an `AsyncService`, so `DI.resolve(fsService)` returns a promise | `fsService` | none | Subclass it and `DI.register(MySubclass).as(fsService)` before the first `DI.resolve(fsService)`. Override `resolve()` (call `super.resolve()`). |
| `FsBootstrapper` | `Bootstrapper`, through `@Injectable(Bootstrapper)` | `FsBootstrapper` | none | Leave it; replace the factory it registers. |
| Provider lookup | `'__file_provider__'`, a factory; the last registered factory wins | name lookup in `'__file_provider_instance__'` | none | `DI.register(factory).as('__file_provider__')` after `FsBootstrapper.bootstrap()` ran. |
| Provider layer | `FsProviderLayer`, `Array.ofType`; register a singleton class | none | `@spinajs/tenancy/fs` | `@Injectable(FsProviderLayer)` on a class that extends it; see [Provider layers](#provider-layers). |
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

Replace the factory to change how a name maps to a provider. This one keeps old provider names working after a rename, so stored `fs://` URIs and `@FileSystem()` names stay valid. A replacement returns `layeredFs(instance)`, as the default factory does: a factory that returns the map entry itself skips the [provider layers](#provider-layers).

```ts sample
import { DI, IContainer, ResolveException } from '@spinajs/di';
import { fs, layeredFs } from '@spinajs/fs';

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

    return layeredFs(instance);
  }).as('__file_provider__');
}
```

### Reading a published provider

`FILE_PROVIDER_INSTANCES` is the provider map key (`'__file_provider_instance__'`). `publishedFs(name, container = DI.RootContainer)` returns the provider published under `name`, or `undefined` when there is none or `fsService` has not resolved. Unlike `getFs()`, it does not go through the `'__file_provider__'` factory and never throws. It also skips the [provider layers](#provider-layers): with `@spinajs/tenancy/fs` it answers the shared provider, not the current tenant's view. Use it where the raw provider is what you want, such as an operator task or a check that compares a provider with its layered view; code that reads or writes an application's files uses `getFs()`.

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
- `getFs()` returns an `fs` instance unchanged without calling the factory, so no provider layer applies to it.

## Provider layers

A class registered as `FsProviderLayer` decides what a lookup by name hands out: `getFs(name)`, `provider(name)`, `@FileSystem(name)`, `fs://` URIs and every helper that takes a provider name get `layer.wrap(provider)` instead of the published provider. `@spinajs/tenancy/fs` registers one that hands out a tenant's view of the providers listed in `tenancy.fs.prefixed`. With no layer registered a lookup answers the published provider. `publishedFs(name)` always answers the published provider, and so does the provider map.

```ts
@Injectable(FsProviderLayer)
export class ReadOnlyArchive extends FsProviderLayer {
  private readonly views = new Map<string, fs>();

  public wrap(provider: fs): fs {
    if (provider.Name !== 'archive') return provider;
    let view = this.views.get(provider.Name);
    if (view === undefined) this.views.set(provider.Name, (view = new ReadOnlyFs(provider)));
    return view;
  }
}
```

`wrap` runs on every lookup: cache what it builds. A wrapping provider implements the `do*` hooks and calls the wrapped provider's public actions from them; those run inside the outer action, where no middleware runs a second time. Layers apply in registration order, each to what the one before handed out. `layeredFs(provider, container = DI.RootContainer)` applies the registered layers to a provider you hold. With a child container it applies the root container's layers first, then the child's own, each class once. `container` must descend from the container that registers the layers: `layeredFs(provider, new Container())` applies none. Do not list a layer class in a child that an ancestor lists already: when the child also replaces it, both classes run.

Register a layer as a singleton class. Replacing one the usual way, `DI.register(MyLayer).as(TheirLayer)`, applies `MyLayer` in its place. Register the replacement in the container that registers the layer, before the first lookup: a child container's replacement of an ancestor's layer is ignored, and one registered after the first lookup applies only after `DI.uncache(Array.ofType(FsProviderLayer))`.

A lookup throws `InvalidOperation` instead of handing out the published provider when a layer cannot run:

- it is a factory, an instance or a `@NewInstance()` class, also as the replacement of a layer class: `Array.ofType` leaves them out of its result;
- it is registered with `asValue()`, which `Array.ofType` does not read;
- its `wrap()` returns a promise: the next layer would pass it through, and a caller that awaits the lookup would get the published provider;
- it, or a dependency, is an `AsyncService` that has not resolved yet or whose resolution failed. `fsService.resolve()` resolves the root container's layers last, so register them before it resolves: the boot then waits for them, and a failure fails the boot with its own error. A layer registered later is resolved with `await DI.resolve(Array.ofType(FsProviderLayer))` before its first lookup.

A provider that a layer hands out as another object has no file ACL of `@spinajs/authz-fs`: its ACL store refuses every call for that name, in every mode, and its checks refuse `audit` and `enforce`, because authz-fs cannot tell a view that keeps the provider's paths from one that maps them per tenant ([ACL store](../authz-fs/07-acl-store.md#important-behaviour)).

## Best practices

- Throw `ResolveException` from a custom factory for an unknown name, like the default one. Code that catches it keeps working.
- Call `super.resolve()` first in a `fsService` subclass: providers exist only after it.

## Related

- [Providers and configuration](01-providers-and-configuration.md): the boot flow and lookup APIs.
- [Middlewares](07-middlewares.md): run around every action of the providers `fsService` creates.
- [CLI commands](11-cli-commands.md): resolve `fsService` on their own.
