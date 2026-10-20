# Factories

A factory is a function registered in place of a class. The container calls it on every resolve and hands out whatever it returns. Use one when building the service needs logic: reading the container, choosing a class at runtime, wrapping a third-party object, or passing arguments a constructor cannot get from DI.

## How it works

1. `DI.register(factory).as(key)` stores the function under `key`. A value is treated as a factory when it is a function that cannot be called with `new` (`isFactory`): an arrow function, or a method shorthand. A `function` declaration or a class is treated as a class.
2. `resolve(key, options?)` picks the last registration; when it is a factory, `Container.getNewInstance()` calls `factory(container, ...options)` where `container` is the resolving container.
3. The return value is handed out as is: no caching, no injection into it, no `SyncService.resolve()` or `AsyncService.resolve()` call. A returned promise is returned as the promise.

The `Factory<T>` type is `(container: IContainer, ...args: any[]) => T`.

| Context | Container the factory receives | Result kept |
| --- | --- | --- |
| `resolve(key)` | The resolving container | No; called on every resolve |
| `@Inject(key)` / `@Autoinject()` | The container building the dependent object | No |
| `Array.ofType(key)` | The resolving container | No; and the result is **left out** of the array |
| `Array.chainOf(key)` | The container that registered the factory | Included in the result |
| `resolveNamed(key, name)` | The resolving container | No |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Any key backed by a factory | The key; always new (factories are never cached) | Your function | A class registration, a value | `DI.register(otherFactory).as(key)`; the last registration wins. To cache, cache inside the factory |
| A factory that picks a class | The key | Your function | none | Read configuration or options in the factory and `container.resolve()` the chosen class, so that class's own lifetime and injection still apply |

### Choosing an implementation at resolve time

Resolve the chosen class through the container inside the factory: it then gets its dependencies and its lifetime, and the factory only decides which one.

```ts sample
import { DI, IContainer } from '@spinajs/di';

abstract class Cache {
  public abstract get(key: string): string | undefined;
  public abstract set(key: string, value: string): void;
}

class MemoryCache extends Cache {
  protected store = new Map<string, string>();
  public get(key: string) {
    return this.store.get(key);
  }
  public set(key: string, value: string) {
    this.store.set(key, value);
  }
}

class RedisCache extends MemoryCache {
  constructor(public readonly Url: string) {
    super();
  }
}

DI.register((container: IContainer, url?: string) => {
  const target = url ?? process.env.REDIS_URL;
  // container.resolve keeps each class's lifetime: MemoryCache stays one shared instance
  return target ? container.resolve(RedisCache, [target]) : container.resolve(MemoryCache);
}).as(Cache);

const cache = DI.resolve(Cache);
cache.set('greeting', 'hello');
console.log(cache.get('greeting'), DI.resolve(Cache) === cache);
// hello true (when REDIS_URL is not set)
```

## Important behaviour

- A factory never becomes a singleton: `get(key)` and `has(key)` do not see its results, and `dispose()` never disposes them. `singleInstance()` and `asSelf()` on a factory throw `BindException`.
- Factories are always appended to a key's list, even the same function twice, because they cannot be told apart by name.
- `Array.ofType(key)` calls every factory but leaves the results out of the array. Use `Array.chainOf(key)` for lists with factories.
- An object returned by a factory is not injected: `@Autoinject` properties on its class stay empty unless the factory resolves the class through the container.
- A string key backed by a factory resolves with `DI.resolve('key')`; a string key with no registration resolves to `null`.

## Best practices

- Return `container.resolve(SomeClass, [...])` rather than `new SomeClass()`, so injection and lifetimes keep working.
- Name a factory (`const` or `Object.defineProperty`) when it must be selectable by [name](07-named-services.md).
- Use the `container` argument, not `DI`, inside a factory: it is the child container when the resolve happens in one.

## Patterns and antipatterns

```ts
// Don't: `new` skips injection; Log stays undefined in ReportMailer
DI.register(() => new ReportMailer()).as(Mailer);

// Do
DI.register((c: IContainer) => c.resolve(ReportMailer)).as(Mailer);
```

## Examples

### Wrap a third-party client and share it

```ts sample
import { DI, IContainer } from '@spinajs/di';

// Stand-in for an SDK client that is not a SpinaJS service.
class S3Client {
  constructor(public readonly Region: string) {}
}

abstract class ObjectStore {
  public abstract readonly Client: S3Client;
}

let shared: S3Client | undefined;

DI.register((_container: IContainer, region = 'eu-central-1') => {
  // Factories are never cached, so the factory keeps the single client itself.
  shared ??= new S3Client(region);
  return { Client: shared };
}).as(ObjectStore);

const a = DI.resolve(ObjectStore);
const b = DI.resolve(ObjectStore);
console.log(a === b, a.Client === b.Client, a.Client.Region);
// false true eu-central-1
```

## Related

- [Registering services](01-registering-services.md): `register()` and which registration wins.
- [Named services](07-named-services.md): selecting a factory by its function name.
- [Multiple implementations](06-multiple-implementations.md): factories in `Array.ofType` and `Array.chainOf`.
