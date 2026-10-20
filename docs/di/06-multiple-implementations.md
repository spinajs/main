# Multiple implementations

A key can hold many registrations. A single resolve takes the last one; a list resolve returns all of them. This is the plugin mechanism of SpinaJS: a package declares an abstract base, other packages register implementations with `@Injectable(Base)`, and the consumer injects the whole list.

## How it works

`Array.ofType(T)` returns a `TypedArray<T>` and `Array.chainOf(T)` a `ChainArray<T>`. Both are markers you pass to `resolve()`, `@Inject` or `@Autoinject`; `T` can be a class or a string key.

### `Array.ofType(T)`: the nearest list

1. `Container.resolve()` finds the owner of `T`: the nearest container, starting at this one, that registered `T`.
2. When the owner is an ancestor, the owner resolves the list and its collection cache serves this container too. When the list holds a `@PerChildInstance()` class, singletons are still built in the owner and the rest in this container.
3. In the owner, the cached collection is returned when no class was registered under `T` since it was built.
4. Otherwise every registration is resolved (`resolveType`). Each singleton is cached twice: in the collection under `T`'s name and under its own class name.
5. The result is the cached collection: an array, or a `Promise` of it when an element is async. Nothing registered gives `[]`.

### `Array.chainOf(T)`: the whole lineage

1. `Registry.getTypesChain(T)` walks the containers from the root down to this one and merges their lists:
   - ancestors come first;
   - a class registered lower down under the name of an ancestor's class replaces that class in place;
   - factories are always kept.
2. Each element is resolved in the container that registered it; a `@PerChildInstance()` class is resolved in this container. A factory is called with the container that registered it.
3. The result is a `Promise` when `T` extends `AsyncService` or any element is async; otherwise an array. Constructor options are not passed to the elements.

| | `Array.ofType(T)` | `Array.chainOf(T)` |
| --- | --- | --- |
| Child registers under `T` | Child's list hides the parent's | Parent's and child's merged, parent first |
| Factory registrations | Called, but **left out** of the result | Included |
| `@NewInstance()` registrations | Built, but **left out** of the result | Included |
| Result cached as a collection | Yes, under `T`'s name | No; elements are cached by their own containers |
| `DI.get(...)` | Returns the cached collection | Throws `InvalidArgument` |
| Return type | `T[]`, `Promise<T[]>` for an `AsyncService` base | `Promise<T[]>` for an `AsyncService` base, else `T[] \| Promise<T[]>` |

### Injecting a list or a map

| Declaration | Injects |
| --- | --- |
| `@Inject(Array.ofType(T))` | `T[]` as a constructor argument |
| `@Inject(Array.chainOf(T))` | The chain as a constructor argument |
| `@Autoinject(T) prop: T[]` | `Array.ofType(T)` |
| `@Autoinject(Array.chainOf(T)) prop: T[]` | `Array.chainOf(T)` |
| `@Autoinject(T, { mapFunc }) prop: Map<string, T>` | The list as a `Map` keyed by `mapFunc(instance)` |
| `@Autoinject(Array.chainOf(T), { mapFunc }) prop: Map<string, T>` | The chain as a `Map` |

`container.getRegisteredTypes(Array.chainOf(T))` returns the merged registrations in resolve order: element `i` is the registration of instance `i`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| A plugin list under an abstract base, eg. `Bootstrapper`, `ConfigurationSource` (`@spinajs/configuration`), `ControllerSource` (`@spinajs/http`) | The base class name; each element keeps its own lifetime | What the installed packages register | Your class | Add one: `@Injectable(Base)` or `DI.register(MyImpl).as(Base)`. Remove one: `DI.unregister(Impl)` before the first list resolve |
| A scope-specific addition | The same base in a child container | The parent's elements | Your class in the child | `child.register(MyImpl).as(Base)`; consumers must resolve `Array.chainOf(Base)` to see both |
| A scope-specific replacement of one element | A class with the **same name** registered in the child | The ancestor's class | Your class | Register a child class with the ancestor class's name; `Array.chainOf` puts it in the ancestor's slot |

### Adding a plugin

Declare the extension contract as an abstract class, inject `Array.ofType(Base)` (or `Array.chainOf(Base)` when children may add elements), and let every module contribute with `@Injectable(Base)`. The module must be imported before the list is first resolved.

```ts sample
import { AsyncService, Autoinject, DI, Injectable } from '@spinajs/di';

abstract class HealthCheck {
  public abstract readonly Name: string;
  public abstract check(): Promise<boolean>;
}

@Injectable(HealthCheck)
class DatabaseCheck extends HealthCheck {
  public readonly Name = 'database';
  public async check() {
    return true;
  }
}

// A third-party module adds its own check without touching HealthService.
@Injectable(HealthCheck)
class DiskSpaceCheck extends HealthCheck {
  public readonly Name = 'disk';
  public async check() {
    return false;
  }
}

class HealthService extends AsyncService {
  @Autoinject(HealthCheck)
  protected Checks: HealthCheck[];

  public async report() {
    const results = await Promise.all(this.Checks.map(async (c) => [c.Name, await c.check()] as const));
    return Object.fromEntries(results);
  }
}

async function main() {
  const health = await DI.resolve(HealthService);
  console.log(await health.report(), DatabaseCheck.name, DiskSpaceCheck.name);
  // { database: true, disk: false }
}

void main();
```

## Important behaviour

- `Array.ofType` drops factory and `@NewInstance()` registrations from its result even though it builds them. Use `Array.chainOf` when the list can hold either.
- A class registered under `T` after the collection was built is picked up on the next `Array.ofType(T)` resolve; already built elements keep their identity.
- A singleton reached through `Array.ofType(T)` is also cached under its own name, so `DI.resolve(DatabaseCheck)` returns the same instance.
- `resolve(Array.chainOf(T))` with a non-async base is typed `T[] | Promise<T[]>`; `await` it.
- A key recorded only because an unregistered class was resolved does not take part in `Array.chainOf` once any container registers that key.
- `Array.ofType(T)` and `Array.chainOf(T)` in one `@Inject` are two separate dependencies.
- **A second copy of `@spinajs/di` in the process** (the cjs and the mjs build side by side, or the packages of another checkout) does not replace `Array.ofType` and `Array.chainOf`: each is installed on `Array` only when absent, so the first copy loaded keeps them.
- The container recognises a list marker by its class name (`TypedArray`, `ChainArray`), not by `instanceof`. A marker built by another copy resolves as a list, collects singletons already cached under their own name, and is cached as the collection, not as its first element.

## Best practices

- Name extension contracts after their role (`HealthCheck`, `ConditionFunction`) and make them abstract classes, so they work as DI keys and as types.
- Give each element a stable name property and inject a `Map` with `mapFunc` when consumers pick elements by name.
- In code that runs inside child containers (domains, tenants), resolve `Array.chainOf(Base)`; `Array.ofType(Base)` silently hides the parent's elements once a child adds one.

## Patterns and antipatterns

```ts
// Don't: the factory runs, but its result is not in the array
DI.register(() => new SlackNotifier(webhook)).as(Notifier);
DI.resolve(Array.ofType(Notifier)); // SlackNotifier missing

// Do: chainOf keeps factory results
await DI.resolve(Array.chainOf(Notifier));
```

## Examples

### Add a tenant-only audit sink on top of the global ones

```ts sample
import { Autoinject, DI, Injectable, PerChildInstance } from '@spinajs/di';

abstract class AuditSink {
  public abstract write(event: string): string;
}

@Injectable(AuditSink)
class ConsoleSink extends AuditSink {
  public write(event: string) {
    return `console:${event}`;
  }
}

@PerChildInstance()
class TenantSink extends AuditSink {
  public write(event: string) {
    return `tenant-db:${event}`;
  }
}

class Auditor {
  @Autoinject(Array.chainOf(AuditSink))
  protected Sinks: AuditSink[];

  public log(event: string) {
    return this.Sinks.map((s) => s.write(event));
  }
}

async function main() {
  const tenant = DI.child();
  tenant.register(TenantSink).as(AuditSink);

  const auditor = await tenant.resolve(Auditor);
  console.log(auditor.log('login'), ConsoleSink.name);
  // [ 'console:login', 'tenant-db:login' ]

  console.log(tenant.getRegisteredTypes(Array.chainOf(AuditSink)).map((t) => t.name));
  // [ 'ConsoleSink', 'TenantSink' ]
}

void main();
```

## Related

- [Registering services](01-registering-services.md): `@Injectable(Base)` and `DI.register().as(Base)`.
- [Child containers](05-child-containers.md): owner rules that decide where list elements live.
- [Named services](07-named-services.md): pick one element of a chain by name.
- [Injection decorators](03-injection-decorators.md): `mapFunc` and the other `@Autoinject` options.
- [`@spinajs/configuration`: config files](../configuration/03-config-files.md#search-directories): the config search stops at the workspace root, so a nested checkout does not load a second copy of the framework packages.
