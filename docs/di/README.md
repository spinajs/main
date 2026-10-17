# `@spinajs/di`

The dependency injection container of SpinaJS. It registers classes, factories and values under keys, builds instances with their dependencies, and keeps them for the lifetime you choose. Every other `@spinajs/*` package registers its services here, and you replace or extend them here.

It does **not** load files or scan directories: a class is registered when its module is imported (decorators run) or when you call `DI.register()`. Directory loading is [`@spinajs/reflection`](../reflection/README.md); picking a service by a configuration value is [`@spinajs/configuration`](../configuration/README.md).

## Install

```sh
npm install @spinajs/di
```

The decorators read TypeScript metadata. Set these in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false
  }
}
```

The package imports `reflect-metadata` itself.

## Features

| Feature | What it does |
| --- | --- |
| [Registering services](01-registering-services.md) | `DI.register()`, `@Injectable`, the `IBind` methods, how keys work, replacing and extending a registered service |
| [Resolving services](02-resolving-services.md) | `resolve`, `get`, `has`, `resolveOptional`, constructor options, the strict check, sync and async results |
| [Injection decorators](03-injection-decorators.md) | `@Inject`, `@Autoinject` and its options (lazy injection included), `@LazyInject`, injection through inheritance |
| [Lifetimes](04-lifetimes.md) | `@Singleton`, `@NewInstance`, `@PerChildInstance`, `@PerInstance`, `@PerInstanceCheck` and `IInstanceCheck` |
| [Child containers](05-child-containers.md) | `child()`, per-scope overrides, which container owns a singleton, disposal, standalone and custom containers |
| [Multiple implementations](06-multiple-implementations.md) | `Array.ofType`, `Array.chainOf`, injecting lists and maps, plugin-style extension |
| [Named services](07-named-services.md) | `getRegisteredNames`, `resolveNamed`, named factories, `IMappableService` |
| [Factories](08-factories.md) | Factory functions as registrations: arguments, lifetime, choosing an implementation at resolve time |
| [Values and value maps](09-values-and-value-maps.md) | `asValue` and `asMapValue`: plain objects in the container, keyed lookups |
| [Service lifecycle](10-service-lifecycle.md) | `SyncService`, `AsyncService`, `Bootstrapper`, `dispose()` |
| [Custom injection decorators](11-custom-injection-decorators.md) | `AddDependency`, `AddDependencyForProperty`, `IToInject` with `resolveFunc`, `serviceFunc`, `mapFunc` |
| [Container events](12-container-events.md) | `di.registered.*`, `di.resolved.*`, `di.dispose` and the built-in `EventEmitter` |
| [Module loading](13-module-loading.md) | `DI.__spinajs_require__`, ESM mode, a custom `DI.IModuleLoader` under `__module_loader__` |
| [Descriptor inheritance](14-descriptor-inheritance.md) | `getInheritedDescriptor` and `collapseInheritedDescriptor` for decorator authors |
| [Utilities and types](15-utilities-and-types.md) | `sortByDependencies`, type guards, `getTypeName`, exceptions, `Class`, `Factory` and result types |

## Quick start

Register an implementation under an abstract base class, then resolve the class that depends on it.

```ts sample
import { Autoinject, DI, Injectable } from '@spinajs/di';

abstract class PasswordHasher {
  public abstract hash(password: string): string;
}

@Injectable(PasswordHasher)
class ReversingHasher extends PasswordHasher {
  public hash(password: string): string {
    return password.split('').reverse().join('');
  }
}

class SignupService {
  @Autoinject()
  protected Hasher: PasswordHasher;

  public register(email: string, password: string) {
    return { email, hash: this.Hasher.hash(password) };
  }
}

const signup = DI.resolve(SignupService);
console.log(signup.register('ann@example.com', 'secret'), ReversingHasher.name);
```

## Related packages

- [`@spinajs/configuration`](../configuration/README.md): `@Config`, `@AutoinjectService` and `resolveNamedService` pick services by configuration, built on [custom injection decorators](11-custom-injection-decorators.md) and [named services](07-named-services.md).
- [`@spinajs/reflection`](../reflection/README.md): `@ResolveFromFiles` and `@ListFromFiles` load classes from directories with `DI.__spinajs_require__` and resolve them through this container.
- [`@spinajs/exceptions`](../exceptions/README.md): `InvalidArgument` and `InvalidOperation`, thrown by the container.
- [`@spinajs/util`](../util/README.md): `isPromise` and `uniqueBy`, used by the container.
