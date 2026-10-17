# Utilities and types

Helpers the container uses internally and exports for packages built on it: dependency ordering, type guards, key naming, exceptions and the types behind the `resolve()` overloads.

## `sortByDependencies`

`sortByDependencies(items, key, dependencies)` orders items so that each comes after the items it depends on. Use it when services that reference each other by name must be created in order, eg. `@spinajs/fs` creates a temp file provider after the provider it wraps.

1. Every item is indexed by `key(item)`.
2. A depth-first walk visits each item's `dependencies(item)` (a string, an array of strings, or `null`/`undefined`) before the item itself.
3. Items with no dependencies keep their input order (the sort is stable).

It throws `ResolveException` for:

| Case | Message |
| --- | --- |
| Two items with one key | `Duplicate key '<k>' found while sorting by dependencies` |
| An item depending on itself | `'<k>' depends on itself` |
| A dependency not in `items` | `'<k>' depends on '<dep>' which does not exist in sorted collection` |
| A cycle | `Circular dependency detected: 'a' -> 'b' -> 'a'` |

```ts sample
import { sortByDependencies } from '@spinajs/di';

type ProviderConfig = { name: string; wraps?: string };

const providers: ProviderConfig[] = [
  { name: 'temp', wraps: 'local' },
  { name: 'cache', wraps: 'temp' },
  { name: 'local' },
];

const ordered = sortByDependencies(
  providers,
  (p) => p.name,
  (p) => p.wraps,
);

console.log(ordered.map((p) => p.name));
// [ 'local', 'temp', 'cache' ]
```

## Type guards and naming

| Function | Returns `true` when |
| --- | --- |
| `isConstructor(value)` | `value` can be called with `new` (classes and `function` declarations) |
| `isFactory(value)` | `value` is a function that cannot be called with `new` (arrow functions) |
| `isClass(value)` | The constructor source starts with `class`; does not work with code transpiled to ES5 functions |
| `isObject(value)` | `typeof value === 'object'` |
| `isAsyncService(value)` / `isSyncService(value)` | `value` is an instance of `AsyncService` / `SyncService` |
| `isTypedArray(value)` | `value` is an `Array.ofType` or `Array.chainOf` marker, or a `Map` |
| `isChainArray(value)` | `value` is an `Array.chainOf` marker |
| `isMap(value)` | `value` is a plain `Map` |
| `isPromise(value)` | Re-exported from `@spinajs/util` |

| Function | Result |
| --- | --- |
| `getTypeName(type)` | The registry and cache key: a string as is, a list marker's element name, a class's name (`AnonymousClass#<n>` for an anonymous class), or an instance's class name |
| `uniqBy(array, comparator)` | The array without items the comparator finds equal to an earlier one |

## Exceptions

| Class | Thrown when |
| --- | --- |
| `ResolveException(message?, InnerError?)` | `sortByDependencies` fails; a `@PerInstanceCheck()` class lacks `__checkInstance__`. `InnerError` carries an optional cause |
| `BindException` | `asSelf()` on a factory or value; `singleInstance()` on a factory |
| `ServiceNotFound` | `resolveNamed` finds no such name; a `serviceFunc` names an unregistered service |

The container also throws `InvalidArgument` and `InvalidOperation` from [`@spinajs/exceptions`](../exceptions/README.md), and a plain `Error` for the strict check and circular singletons; see [Resolving services](02-resolving-services.md#errors).

## Types

| Type | Definition |
| --- | --- |
| `Abstract<T>` | `Function & { prototype: T }`: an abstract class |
| `Constructor<T>` | `new (...args: any[]) => T` |
| `Class<T>` | `Abstract<T> \| Constructor<T>`: anything usable as a key |
| `Factory<T>` | `(container: IContainer, ...args: any[]) => T` |
| `ClassArray<T>` | `Class<T>[]` |
| `ResolveResult<T>` | `T extends AsyncService ? Promise<T> : T` |
| `ResolveArrayResult<T>` | `T extends AsyncService ? Promise<T[]> : T[]` |
| `ResolveChainResult<T>` | `T extends AsyncService ? Promise<T[]> : T[] \| Promise<T[]>` |
| `InferClass<T>`, `InferTypedArray<T>`, `InferClassOrFactory<T>` | The instance type behind a class, a list marker, or a class or factory |
| `ResolvableObject` | `{ [key: string]: any }`: a value for `asValue` / `asMapValue` |
| `TypedArray<R>` / `ChainArray<R>` | The classes behind `Array.ofType` / `Array.chainOf`; `Type` holds the element key |
| `ClassInfo<T>` | `{ file, name, type, instance? }`: a loaded class, used by `@spinajs/reflection` |
| `IChainRegistration` | `{ type, container }`: one `Array.chainOf` entry and its registering container |
| `IResolvedInjection` | `{ instance, autoinject, autoinjectKey }`: one resolved dependency passed to `getNewInstance` |

## Container internals

These classes are public so tools and tests can inspect a container; the container creates them itself and you cannot swap them.

| Class | Useful members |
| --- | --- |
| `Registry` | `getTypes(key, parent = true)`, `getTypesChain(key)`, `hasRegistered(key, parent)`, `hasRegisteredType(key, type, parent)`, `ownsRegistration(key)` |
| `ContainerCache` | Iterable as `{ key, value }`; `has(key, parent?)`, `get(key, parent?)`, `getResolutionStats()` (`{ cacheSize, activeResolutions, resolutionKeys }`) |
| `Binder` | The `IBind` implementation returned by `register()` |

## Related

- [Resolving services](02-resolving-services.md): where these types appear in the `resolve()` overloads.
- [Child containers](05-child-containers.md): `Registry` and `Cache` per container.
