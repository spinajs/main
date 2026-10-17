# Registering services

A registration tells the container which class, factory or value to hand out for a key. Register with `DI.register()` or with the `@Injectable` decorator. This is also how you replace a service another package ships: register your class under the same key.

## How it works

1. `DI.register(implementation)` (root container) or `container.register(implementation)` checks the argument and returns a `Binder`, the `IBind` implementation. A falsy argument (`undefined`, `null`, `0`, `''`) throws `InvalidArgument`.
2. A `Binder` method stores the registration:
   - `as(key)` and `asSelf()` add the implementation to the container's `Registry` under the key's name.
   - `asValue(key)` and `asMapValue(key, hashKey)` put the object straight into the container's cache; see [Values and value maps](09-values-and-value-maps.md).
3. `Registry.register()` throws `InvalidOperation` for anything that is not a class, a function or an object. Under one key it keeps a list: a class already in the list (same name) is not added twice; a factory is always appended.
4. The binder emits `di.registered.<ImplementationName>` and `di.registered.<KeyName>` on the container; see [Container events](12-container-events.md).
5. Nothing is built yet. The first `resolve()` of the key builds the instance; see [Resolving services](02-resolving-services.md).

`@Injectable(key?)` runs at class definition time. It calls `DI.register(target).as(key)` when you pass a key, then `DI.register(target).asSelf()`. It always registers in the root container.

### Keys are names

- A class key is the class name (`Clock` → `'Clock'`). A string key is used as is.
- An anonymous class gets a generated name, `AnonymousClass#<n>`, pinned to that constructor.
- Two different classes with the same name share one key, one registry list and one cache entry. The second resolves to the first one's instance.

### Which registration wins

- A single `resolve(key)` takes the **last** registration under the key.
- It follows registrations through: with `B` registered as `A` and `C` registered as `B`, `resolve(A)` returns a `C`.
- A key with no registration resolves to the class itself. A string key with no registration resolves to `null`.
- A list resolve (`Array.ofType`, `Array.chainOf`) returns every registration; see [Multiple implementations](06-multiple-implementations.md).

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Injectable(as?)` | class | `as`: base class or string key | Registers the class under `as` (when given) and under itself, in the root container |

## `IBind` methods

| Method | Effect |
| --- | --- |
| `as(key)` | Registers the implementation under `key` (a class or a string) |
| `asSelf()` | Registers a class under its own name; throws `BindException('cannot register as self non class')` for a factory or a value |
| `asValue(key, override = false)` | Stores the object as is in the cache under `key`; see [Values and value maps](09-values-and-value-maps.md) |
| `asMapValue(key, hashKey)` | Adds the object to a `Map` cached under `key`, at `hashKey` |
| `singleInstance()` | Meant to force the singleton lifetime; it does **not** change the lifetime (see Important behaviour). Throws `BindException` for a factory |

All methods return the binder, so calls chain: `DI.register(SmtpMailer).as(Mailer).asSelf()`.

## Checking and removing registrations

| Call | Returns or does |
| --- | --- |
| `DI.check(key)` / `container.hasRegistered(key, parent = true)` | `true` when the registry (and, with `parent`, an ancestor's registry) has an entry for `key`. Values from `asValue` are **not** registry entries |
| `DI.checkType(key, implementation)` / `container.hasRegisteredType(key, implementation, parent?)` | `true` when `implementation` is in the list under `key` |
| `DI.getRegisteredTypes(key)` / `container.getRegisteredTypes(key, parent?)` | The list under `key` from the nearest container that has one, or `null` |
| `DI.unregister(implementation)` / `container.unregister(implementation)` | Removes the implementation from every list in this registry; an emptied list is deleted, so the key falls back to its default |
| `DI.uncache(key, parent?)` / `container.uncache(key, parent?)` | Drops the cached instances under `key`, so the next resolve builds again |
| `DI.clearRegistry()`, `DI.clearCache()`, `DI.clear()` | Empty the root registry, the root cache, or both |

## Services and extension points

The container ships no replaceable services of its own; every key is one you or another package registers. The mechanisms below apply to any of them.

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Any service registered under a base class, eg. `FileHasher` in `@spinajs/fs` | The base class name; lifetime from the implementation's decorators (Singleton by default) | Whatever the owning package registers with `@Injectable(Base)` | Your class | `DI.register(MyImpl).as(Base)` after the package is imported and before the first resolve; or subclass the default and register the subclass |
| A service under a string key | The string; lifetime from the implementation | The package's registration | Your class or factory | `DI.register(MyImpl).as('key')` |
| A service in one scope only | The same key in a child container | The root registration | Your class in the child | `child.register(MyImpl).as(Base)`; see [Child containers](05-child-containers.md) |

### Replacing a registered service

Register your class under the same key. Do it:

- **after** the module that registers the default is imported, because `@Injectable` registers at import time and the last registration wins;
- **before** anything resolves the key. A singleton already built stays in the cache and in every object it was injected into. A later registration only affects later resolves.

To extend instead of replace, subclass the default implementation, override the methods you need, call `super` for the rest, and register the subclass under the same key.

```ts sample
import { DI, Injectable } from '@spinajs/di';

abstract class Clock {
  public abstract now(): Date;
}

@Injectable(Clock)
class SystemClock extends Clock {
  public now(): Date {
    return new Date();
  }
}

// Tests freeze time: the fixed clock is registered last, so it wins.
class FixedClock extends Clock {
  constructor(protected readonly at = new Date('2026-01-01T00:00:00Z')) {
    super();
  }

  public now(): Date {
    return this.at;
  }
}

DI.register(FixedClock).as(Clock);

const clock = DI.resolve(Clock);
console.log(clock.now().toISOString(), DI.getRegisteredTypes(Clock).map((t) => t.name), SystemClock.name);
// 2026-01-01T00:00:00.000Z [ 'SystemClock', 'FixedClock' ]
```

## Important behaviour

- `@Injectable` always registers in the root container, at import time. Import order decides which of two `@Injectable(Base)` classes a single `resolve(Base)` returns.
- `singleInstance()` sets the lifetime on a fresh copy of the class descriptor, so it has no effect. A class without lifetime decorators is a singleton anyway; a `@NewInstance()` class stays new-instance.
- Resolving a class that is registered nowhere records it in the resolving container's registry under its own name (except `@NewInstance()` classes). After `DI.resolve(Report)`, `DI.check(Report)` is `true`.
- `unregister()` matches by name in every list of the registry. It does not touch the cache: call `uncache(key)` too, or the old instance keeps coming back.
- Registration is synchronous and never builds anything. An error in a constructor shows up on the first resolve, not on register.

## Best practices

- Register under an abstract base class, not a concrete one. The base is the contract consumers inject; implementations stay swappable.
- Put overrides of framework services in one place that runs after the packages are imported and before bootstrap, eg. the top of your entry file.
- Use `DI.checkType(Base, MyImpl)` in a startup check when your app depends on one specific implementation being registered.

## Patterns and antipatterns

```ts
// Don't: the override comes after the first resolve; Orders already holds SystemClock
const orders = DI.resolve(Orders);
DI.register(FixedClock).as(Clock);

// Do: register first, then resolve
DI.register(FixedClock).as(Clock);
const orders = DI.resolve(Orders);
```

```ts
// Don't: two classes named `Repository` in different modules share one cache entry
export class Repository {} // users/repository.ts
export class Repository {} // orders/repository.ts

// Do: give every injectable class a unique name
export class UserRepository {}
export class OrderRepository {}
```

## Examples

### Swap the mail transport in a staging build

```ts sample
import { DI, Injectable } from '@spinajs/di';

abstract class MailTransport {
  public abstract send(to: string, subject: string): Promise<string>;
}

@Injectable(MailTransport)
class SmtpTransport extends MailTransport {
  public async send(to: string, subject: string) {
    return `smtp:${to}:${subject}`;
  }
}

// Extends the default instead of replacing its logic: every message goes to one inbox.
class StagingTransport extends SmtpTransport {
  public async send(_to: string, subject: string) {
    return super.send('staging-inbox@example.com', `[staging] ${subject}`);
  }
}

if (process.env.APP_ENV === 'staging') {
  DI.register(StagingTransport).as(MailTransport);
}

async function main() {
  const transport = DI.resolve(MailTransport);
  console.log(await transport.send('ann@example.com', 'Welcome'));
  console.log(DI.checkType(MailTransport, StagingTransport));
}

void main();
```

## Related

- [Resolving services](02-resolving-services.md): what happens when a registration is resolved.
- [Lifetimes](04-lifetimes.md): how long a registered class's instance lives.
- [Child containers](05-child-containers.md): registrations that apply to one scope only.
- [Multiple implementations](06-multiple-implementations.md): every registration under a key, not only the last.
