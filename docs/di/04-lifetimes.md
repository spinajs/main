# Lifetimes

A lifetime decides whether a resolve reuses an instance or builds a new one, and in which container the instance is kept. Set it with a class decorator; without one, a class is a singleton.

## How it works

1. A lifetime decorator writes `ResolveType` into the class's injection descriptor (`IInjectDescriptor.resolver`).
2. On resolve, `Container.resolveType()` reads it with `extractDescriptor()`:
   - `NewInstance`: the class is built on every resolve and never cached.
   - Any other value: `ContainerCache.getOrCreate()` returns the cached instance, or builds and caches one.
3. The cache key is the **concrete class name** (`SmtpMailer`, not `Mailer`), in the container that owns the registration; see [Child containers](05-child-containers.md#which-container-owns-an-instance).
4. `PerInstanceCheck` asks every cached instance `__checkInstance__(options)` and returns the first that answers `true`.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Singleton()` | class | none | One instance per owning container. The default, so the decorator only documents intent |
| `@NewInstance()` | class | none | A new instance on every resolve and every injection. Not cached, not recorded in the registry; `DI.get()` never returns it |
| `@PerChildInstance()` | class | none | One instance per container: the root has one, every child builds its own |
| `@PerInstance()` | class | none | Cached like `Singleton`: one instance per concrete class in the owner container |
| `@PerInstanceCheck()` | class | none | One instance per distinct set of constructor options, chosen by the instance's `__checkInstance__(options)` |

`ResolveType` has the matching members: `Singleton`, `NewInstance`, `PerChildContainer`, `PerInstance`, `PerInstanceCheck`.

When a class has several lifetime decorators, the one closest to `class` runs first and the top one wins.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `IInstanceCheck` | Implemented by a `@PerInstanceCheck()` class; no token | none | Shipped in `DefaultFileHasher` (`@spinajs/fs`), `FileTarget` (`@spinajs/log`), the OTLP and Loki log targets | Implement `__checkInstance__(creationOptions: any): boolean`; `creationOptions` is the `options` array given to `resolve()` |
| The lifetime of a class you do not own | Its key; its own decorator | The package's choice | Your subclass with another lifetime decorator | Subclass, decorate, `DI.register(Sub).as(Base)` |

### `IInstanceCheck`: one instance per option set

Use `@PerInstanceCheck()` when a class is built with options and two resolves with the same options should share one instance, eg. one hasher per algorithm or one log target per file. The container calls `__checkInstance__(options)` on each cached instance; the first `true` wins. A `@PerInstanceCheck()` class without `__checkInstance__` throws `ResolveException` on the second resolve.

```ts sample
import { DI, IInstanceCheck, PerInstanceCheck } from '@spinajs/di';

@PerInstanceCheck()
class RateLimiter implements IInstanceCheck {
  protected hits = 0;

  constructor(public readonly Bucket: string, public readonly PerMinute: number) {}

  public __checkInstance__(creationOptions: unknown[]): boolean {
    return this.Bucket === creationOptions[0];
  }

  public allow(): boolean {
    return ++this.hits <= this.PerMinute;
  }
}

const login = DI.resolve(RateLimiter, ['login', 5]);
const sameLogin = DI.resolve(RateLimiter, ['login', 5]);
const upload = DI.resolve(RateLimiter, ['upload', 20]);

console.log(login === sameLogin, login === upload);
// true false
```

## Important behaviour

- `@PerInstanceCheck()` caches only the **first** instance of a class. An instance built for different options is returned but not cached, so `DI.resolve(RateLimiter, ['upload', 20])` builds a new limiter on every call. Keep a reference yourself when that matters.
- `@PerInstance()` behaves exactly like `@Singleton()` in the current container: both cache one instance per concrete class.
- A singleton resolved through a child container is created and cached in the container that registered it (usually the root), with that container's dependencies. A class registered nowhere is cached where it is first resolved: when that is the root, children reuse it; when it is a child, a sibling child builds its own. Register app-wide singletons in the root (`DI.register(Pool).asSelf()`).
- Options passed to `resolve()` are ignored when a cached instance is returned.
- `@NewInstance()` and factory registrations are left out of `Array.ofType` results; see [Multiple implementations](06-multiple-implementations.md#important-behaviour).
- A subclass with its own `@Inject` or `@Autoinject` gets the `Singleton` default, not the base class's lifetime. Repeat the lifetime decorator on the subclass.
- `dispose()` only reaches cached instances; a `@NewInstance()` object is never disposed by the container. See [Service lifecycle](10-service-lifecycle.md).

## Best practices

- Leave stateless services as singletons; mark only stateful, per-use objects (builders, request contexts, compilers) `@NewInstance()`.
- Use `@PerChildInstance()` for state that belongs to one scope, eg. one cache per tenant container.
- Make `__checkInstance__` compare the same values the constructor used, including defaults, so an omitted option matches the instance built without it.

## Patterns and antipatterns

```ts
// Don't: a singleton keeps the options of whoever resolved it first
class Exporter {
  constructor(public readonly Format: string) {}
}
DI.resolve(Exporter, ['csv']);
DI.resolve(Exporter, ['xlsx']).Format; // 'csv'

// Do: a new instance per call when the constructor takes per-call options
@NewInstance()
class Exporter {
  constructor(public readonly Format: string) {}
}
```

## Examples

### One query context per request, one connection pool per app

```ts sample
import { Autoinject, DI, NewInstance, PerChildInstance, Singleton } from '@spinajs/di';

@Singleton()
class ConnectionPool {
  public readonly CreatedAt = Date.now();
}

@PerChildInstance()
class TenantCache {
  public readonly Entries = new Map<string, unknown>();
}

@NewInstance()
class QueryContext {
  @Autoinject()
  public Pool: ConnectionPool;

  @Autoinject()
  public Cache: TenantCache;
}

// Registered in the root, so the root owns and caches the pool for every child.
DI.register(ConnectionPool).asSelf();

const tenantA = DI.child();
const tenantB = DI.child();

const q1 = tenantA.resolve(QueryContext);
const q2 = tenantA.resolve(QueryContext);
const q3 = tenantB.resolve(QueryContext);

console.log(q1 === q2, q1.Pool === q3.Pool, q1.Cache === q2.Cache, q1.Cache === q3.Cache);
// false true true false
```

## Related

- [Resolving services](02-resolving-services.md): where the cache lookup happens in the resolve flow.
- [Child containers](05-child-containers.md): which container keeps a singleton.
- [Service lifecycle](10-service-lifecycle.md): initialization and disposal of cached instances.
