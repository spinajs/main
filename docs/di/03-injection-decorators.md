# Injection decorators

Decorators declare what a class needs; the container supplies it when it builds the class. `@Inject` feeds constructor arguments, `@Autoinject` fills properties, and `@LazyInject` resolves on property access.

## How it works

1. **Declaration.** Each decorator adds an entry (`IToInject`) to the class's injection descriptor, stored as `reflect-metadata` under `DI_DESCRIPTION_SYMBOL` (`'__DI_INJECTION_DESCRIPTOR__'`). `@LazyInject` also adds an entry, which hands the owner the resolving container instead of an instance, and defines the getter that resolves in it.
2. **Collection.** On resolve, `Container.extractDescriptor()` walks the class and every base class and merges their entries:
   - constructor entries (`@Inject`) come first: the class's own, then its bases', each type once;
   - property entries (`@Autoinject`) follow, one per property name.
3. **Resolution.** `resolveDependencies()` resolves every entry in the resolving container. Lists and maps are built for `Array.ofType`, `Array.chainOf` and `mapFunc` entries.
4. **Construction.** `getNewInstance()` calls `new Class(...constructorEntries, ...options)`, then assigns each property entry to the new instance.
5. **Initialization.** `SyncService.resolve()` or `AsyncService.resolve()` runs after the properties are set; see [Service lifecycle](10-service-lifecycle.md).

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Inject(...types)` | class | Classes, `Array.ofType(T)` or `Array.chainOf(T)` | Resolves each type and passes them to the constructor, in order. A type already declared (here or on a base class) is injected once |
| `@Autoinject()` | property | none | Resolves the property's declared type (`design:type`) |
| `@Autoinject(type)` | property | A class, `Array.ofType(T)` or `Array.chainOf(T)` | Resolves `type` instead of the declared type. On an array or `Map` property, a class means `Array.ofType(type)` |
| `@Autoinject(type?, options)` / `@Autoinject(options)` | property | `IAutoinjectOptions` (below) | As above, with options |
| `@LazyInject(type?, { mapFunc }?)` | property | A class, `Array.ofType(T)`, `Array.chainOf(T)` or a string key; omitted: the declared type. On an array or `Map` property, a class means `Array.ofType(type)`; `mapFunc` builds a `Map` as for `@Autoinject` | Replaces the property with a getter that resolves on every read, in the container that built the owner |

### `IAutoinjectOptions`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mapFunc` | `(instance) => string` | none | On an array or `Map` property: build a `Map` keyed by the returned string; `undefined` keys are skipped |
| `options` | `any` | none | Passed to the resolved class's constructor as its first extra argument |
| `check` | `boolean` | `false` | Resolve as `resolve(type, [options], true)`: fail when nothing is registered, instead of building the type itself |
| `optional` | `boolean` | `false` | Resolve as `resolveOptional(type)`: `undefined` when nothing is registered |

`@Autoinject` throws at class definition when:

- `check` and `optional` are both set (`'check and optional exclude each other'`);
- `check` or `optional` is set on an array or `Map` property, or with `Array.chainOf` (`'check and optional take a single class'`);
- `Array.ofType(T)` or `Array.chainOf(T)` is given for a property that is not an array or `Map`.

`@LazyInject` throws at class definition when `Array.ofType(T)` or `Array.chainOf(T)` is given for a property that is not an array, `Map` or `Promise`, or when an array or `Map` property has no type.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| The resolving container | `Container`; the container caches itself under `'Container'` | The container that builds the object | none | `@Autoinject(Container)` or `@Inject(Container)` gets the root or the child container doing the resolve |
| Every injected type | Its own key and lifetime | Last registration under the key | Any registration | Register another class under the key; see [Registering services](01-registering-services.md) |
| Your own injection rule | A property entry with `resolveFunc` or `serviceFunc` | none | `@Config`, `@AutoinjectService` in `@spinajs/configuration` | Write a decorator with `AddDependencyForProperty`; see [Custom injection decorators](11-custom-injection-decorators.md) |

## Important behaviour

- `@Autoinject` properties are **not** set inside the constructor. They are assigned right after it returns. Read them in methods or in `resolve()`, not in the constructor.
- `@Autoinject()` without a type needs `emitDecoratorMetadata`. A build that drops decorator metadata (esbuild, `tsx`) throws when the class is defined; pass the type explicitly there. Without metadata the container cannot see an array or `Map` property, so an explicit class is injected as a single instance.
- `@Autoinject()` or `@Autoinject({ mapFunc })` on an array or `Map` property throws `you must provide inject type when injecting array or map` when the class is defined.
- On an interface-typed property, `design:type` is `Object`. Pass the class explicitly: `@Autoinject(Container)`, not `@Autoinject() c: IContainer`.
- `@LazyInject` always resolves from the **root** container, even for an object built in a child container, and it resolves on every read. With a string key it calls `DI.get(key)`, so it returns only what is already cached.
- `@LazyInject` defines the getter on the prototype. An own class field with the same name shadows it, which happens when `useDefineForClassFields` is `true` (the default for `target` ES2022 and later). Keep `useDefineForClassFields: false`.
- A subclass inherits the lifetime of its nearest decorated base class, also when it adds its own `@Inject` or `@Autoinject`. Put a lifetime decorator (`@Singleton()` included) on the subclass to change it.
- `@Autoinject(Array.chainOf(T))` and `@Autoinject(T)` on an array are different dependencies: the first merges the container lineage, the second takes the nearest list. See [Multiple implementations](06-multiple-implementations.md).

## Best practices

- Use `@Autoinject` for services and `@Inject` plus `options` for classes that also take per-call arguments.
- Declare injected properties `protected` or `public`; the container assigns them by name.
- Mark the dependency on an abstract base with `{ check: true }` when a missing implementation must fail at startup.

## Patterns and antipatterns

```ts
// Don't: Log is not assigned yet when the constructor runs
class Importer {
  @Autoinject()
  protected Log: Log;

  constructor() {
    this.Log.info('ready'); // TypeError
  }
}

// Do: use resolve() of a SyncService, which runs after injection
class Importer extends SyncService {
  @Autoinject()
  protected Log: Log;

  public resolve() {
    this.Log.info('ready');
    super.resolve();
  }
}
```

```ts
// Don't: look the service up on every call to keep it from being built with the owner
class TenantReport {
  @Autoinject(Container)
  protected Container: IContainer;

  public render() {
    return this.Container.resolve(TenantSettings).format();
  }
}

// Do: @LazyInject resolves on read, in the container that built the report
class TenantReport {
  @LazyInject(TenantSettings)
  protected Settings: TenantSettings;

  public render() {
    return this.Settings.format();
  }
}
```

## Examples

### Inject the store, the hasher and every password rule

```ts sample
import { Autoinject, Container, DI, Inject, Injectable, SyncService } from '@spinajs/di';

abstract class PasswordRule {
  public abstract readonly Name: string;
  public abstract test(password: string): boolean;
}

@Injectable(PasswordRule)
class MinLength extends PasswordRule {
  public readonly Name = 'min-length';
  public test(p: string) {
    return p.length >= 12;
  }
}

@Injectable(PasswordRule)
class HasDigit extends PasswordRule {
  public readonly Name = 'has-digit';
  public test(p: string) {
    return /\d/.test(p);
  }
}

class UserStore {
  public readonly users = new Map<string, string>();
}

@Inject(UserStore)
class PasswordPolicy extends SyncService {
  // every registered rule, keyed by its Name
  @Autoinject(PasswordRule, { mapFunc: (r) => r.Name })
  protected Rules: Map<string, PasswordRule>;

  @Autoinject(Container)
  protected Container: Container;

  constructor(protected readonly store: UserStore) {
    super();
  }

  public failed(password: string): string[] {
    return [...this.Rules.values()].filter((r) => !r.test(password)).map((r) => r.Name);
  }
}

const policy = DI.resolve(PasswordPolicy);
console.log(policy.failed('short'));
// [ 'min-length', 'has-digit' ]
```

### Fail at startup when no payment gateway is installed

```ts sample
import { Autoinject, DI } from '@spinajs/di';

abstract class PaymentGateway {
  public abstract charge(cents: number): Promise<string>;
}

abstract class FraudCheck {
  public abstract score(cents: number): number;
}

class Checkout {
  @Autoinject(PaymentGateway, { check: true })
  protected Gateway: PaymentGateway;

  @Autoinject(FraudCheck, { optional: true })
  protected Fraud: FraudCheck | undefined;

  public async pay(cents: number) {
    if ((this.Fraud?.score(cents) ?? 0) > 0.9) {
      throw new Error('payment refused');
    }
    return this.Gateway.charge(cents);
  }
}

async function main() {
  try {
    await DI.resolve(Checkout);
  } catch (err) {
    // Type PaymentGateway is not registered at container
    console.error((err as Error).message);
  }
}

void main();
```

## Related

- [Resolving services](02-resolving-services.md): the resolve flow that uses these declarations.
- [Lifetimes](04-lifetimes.md): lifetime decorators and how inheritance affects them.
- [Multiple implementations](06-multiple-implementations.md): array and `Map` injection.
- [Custom injection decorators](11-custom-injection-decorators.md): write your own property decorator.
