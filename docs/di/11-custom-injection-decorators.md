# Custom injection decorators

`AddDependency` and `AddDependencyForProperty` are the building blocks of every injection decorator in this package. Use them to write your own: inject a computed value, pick a service by a name from configuration, or give a lifetime a domain-specific name. `@Config` and `@AutoinjectService` in `@spinajs/configuration` are built this way.

## How it works

1. **Decoration.** `AddDependency(callback)` (class decorators) and `AddDependencyForProperty(callback)` (property decorators) fetch the class's **own** injection descriptor from `reflect-metadata` under `DI_DESCRIPTION_SYMBOL`. When the class has none, they create `{ inject: [], resolver: ResolveType.Singleton }` and store it.
2. **Callback.** Your callback receives `(descriptor, target, propertyKey, indexOrDescriptor)` and edits the descriptor: push an `IToInject` entry, or set `descriptor.resolver`.
   - For `AddDependency`, `target` is the class.
   - For `AddDependencyForProperty`, `target` is the prototype; the descriptor belongs to `target.constructor`.
3. **Collection.** On resolve, `Container.extractDescriptor(type)` merges the descriptors of the class and its base classes: entries with `autoinjectKey: ''` are constructor arguments, in order; the rest are properties, one per key, the subclass's declaration first.
4. **Resolution.** `Container.resolveDependencies()` turns each entry into a value, in the resolving container:
   - `resolveFunc` set: `resolveFunc(data, container)`; its return value (or the value its promise settles with) is injected. `inject`, `serviceFunc` and `mapFunc` are ignored.
   - `serviceFunc` set: `serviceFunc(data, container)` names the service; see [Selecting a service by name](#selecting-a-service-by-name-servicefunc).
   - Otherwise: `container.resolve(inject, [options])`.
   - `mapFunc` set and the value is an array: it becomes a `Map` keyed by `mapFunc(item)`; `undefined` keys are skipped.
5. **Injection.** Constructor entries are passed to `new`; property entries (`autoinject: true`) are assigned by `autoinjectKey`. Any promise makes the whole resolve async.

## `IToInject` fields

| Field | Type | Meaning |
| --- | --- | --- |
| `inject` | `Class<T> \| TypedArray<T>` | What to resolve; also the base whose registrations `serviceFunc` searches |
| `autoinject` | `boolean` | `true`: assign to a property. `false`: pass to the constructor |
| `autoinjectKey` | `string \| symbol` | The property name; `''` for a constructor argument |
| `data` | `any` | Passed to `resolveFunc` and `serviceFunc`, eg. a configuration path |
| `options` | `any` | Passed to the resolved class's constructor as `[options]` |
| `resolveFunc` | `(data, container) => unknown` | Builds the value itself; may return a promise |
| `serviceFunc` | `(data, container) => IServiceFuncResult \| IServiceFuncResult[] \| undefined` | Names the registration(s) to inject |
| `mapFunc` | `(x) => string \| undefined` | Turns an injected array into a `Map` |

`IInjectDescriptor` is `{ inject: IToInject[]; resolver: ResolveType }`. `container.extractDescriptor(type)` returns the merged descriptor a resolve would use; it is handy in tests and diagnostics.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `AddDependency(callback?)` | class | `callback(descriptor, target, propertyKey, indexOrDescriptor)` | Returns a decorator that edits the class's own descriptor. `@Inject` and every lifetime decorator use it |
| `AddDependencyForProperty(callback?)` | property | Same callback | Returns a decorator that edits the descriptor of the property's class. `@Autoinject` uses it |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Injection entries (`IToInject`) | Metadata `DI_DESCRIPTION_SYMBOL` on the class; read on every resolve | `@Inject`, `@Autoinject` | `@Config`, `@AutoinjectService`, `@AutoinjectNamedService` (`@spinajs/configuration`) | Push your own entry with `AddDependencyForProperty` or `AddDependency` |
| Lifetime | `IInjectDescriptor.resolver` | `ResolveType.Singleton` | The lifetime decorators | Set `descriptor.resolver` in an `AddDependency` callback |

### Injecting a computed value: `resolveFunc`

Use `resolveFunc` when the value does not come from a registration: an environment variable, a value derived from another service, a per-container lookup. It runs in the resolving container, so child-container overrides apply. Return a promise for async work; reject (do not throw) when a sibling dependency may still be pending.

```ts sample
import { AddDependencyForProperty, DI, IContainer, IInjectDescriptor } from '@spinajs/di';

/** Injects an environment variable, or the fallback; fails the resolve when neither is set. */
function FromEnv(name: string, fallback?: string) {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, _target, propertyKey) => {
    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: String,
      data: name,
      resolveFunc: (data: string, _container: IContainer) => {
        const value = process.env[data] ?? fallback;
        return value === undefined ? Promise.reject(new Error(`environment variable ${data} is not set`)) : value;
      },
    });
  });
}

class SmtpSettings {
  @FromEnv('SMTP_HOST', 'localhost')
  public Host: string;

  @FromEnv('SMTP_PORT', '25')
  public Port: string;
}

const settings = DI.resolve(SmtpSettings);
console.log(`${settings.Host}:${settings.Port}`);
// localhost:25
```

### Selecting a service by name: `serviceFunc`

`serviceFunc(data, container)` returns which registration of `inject` to use:

1. `undefined`: the property gets `undefined`.
2. `{ service, options? }`: the container takes the list registered under `inject` (nearest container that has one), finds the class whose **class name** is `service`, and resolves it with `[entry.options ?? result.options]`.
3. An array of them: each is resolved; with `mapFunc` the property gets a `Map`.
4. No registration under `inject`, or no class with that name: `ServiceNotFound`.

```ts sample
import { AddDependencyForProperty, Class, DI, IInjectDescriptor, IServiceFuncResult } from '@spinajs/di';

abstract class Notifier {
  public abstract notify(text: string): string;
}

class EmailNotifier extends Notifier {
  public notify(text: string) {
    return `email: ${text}`;
  }
}

class SlackNotifier extends Notifier {
  public notify(text: string) {
    return `slack: ${text}`;
  }
}

DI.register(EmailNotifier).as(Notifier);
DI.register(SlackNotifier).as(Notifier);

const settings: Record<string, string> = { 'alerts.notifier': 'SlackNotifier' };

/** Injects the registration of `base` whose class name is stored in settings under `key`. */
function NotifierFromSettings(key: string, base: Class<unknown>) {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, _target, propertyKey) => {
    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: base,
      data: key,
      serviceFunc: (data: string): IServiceFuncResult | undefined => (settings[data] ? { service: settings[data] } : undefined),
    });
  });
}

class AlertService {
  @NotifierFromSettings('alerts.notifier', Notifier)
  protected Notifier: Notifier;

  public alert(text: string) {
    return this.Notifier.notify(text);
  }
}

console.log(DI.resolve(AlertService).alert('disk full'));
// slack: disk full
```

### Naming a lifetime: `AddDependency`

A class decorator can set the lifetime under a name your team uses.

```ts sample
import { AddDependency, DI, IInjectDescriptor, ResolveType } from '@spinajs/di';

/** One instance per resolve; reads better than NewInstance in request handlers. */
function PerRequest() {
  return AddDependency((descriptor: IInjectDescriptor<unknown>) => {
    descriptor.resolver = ResolveType.NewInstance;
  });
}

@PerRequest()
class RequestContext {
  public readonly Id = Math.random().toString(36).slice(2);
}

console.log(DI.resolve(RequestContext) === DI.resolve(RequestContext));
console.log(DI.RootContainer.extractDescriptor(RequestContext).resolver === ResolveType.NewInstance);
// false
// true
```

## Important behaviour

- The callback edits the class's **own** descriptor. A new one starts with the lifetime of the nearest decorated base class (`Singleton` when there is none), so a subclass keeps its base's lifetime until a callback sets `descriptor.resolver`; see [Lifetimes](04-lifetimes.md#important-behaviour).
- Property entries are unique per `autoinjectKey`: when a subclass and its base both decorate one property, the subclass's entry wins.
- `@Inject` skips a type already in the descriptor; your own `AddDependency` callback does not, unless you check `descriptor.inject` yourself.
- A `resolveFunc` that throws synchronously while another dependency is pending can leave that one's rejection unhandled. Return `Promise.reject(err)` instead, as `@Autoinject` with `check` does.
- `serviceFunc` matches the class **name** in the nearest list under `inject`. It ignores ancestors' lists once a child registers under `inject`, and it does not see factory names. For lineage-wide, factory-aware lookup use [named services](07-named-services.md).
- A plain entry resolves with `[options]`, so the target constructor receives `options` (or `undefined`) as its first extra argument.

## Best practices

- Prefer `resolveFunc` for new decorators: it is one function, it may be async, and it receives the resolving container.
- Keep `data` serializable (a path, a name) and do the work in `resolveFunc`, so the decorator's arguments are visible in `extractDescriptor()` output.
- Check `descriptor.inject.some((i) => i.autoinjectKey === key)` before pushing when the decorator may run twice for one key, as `@Config` does.

## Patterns and antipatterns

```ts
// Don't: a synchronous throw beside a pending async dependency
resolveFunc: (path, c) => {
  if (!c.hasRegistered(Settings)) throw new Error('no settings');
  return c.resolve(Settings).get(path);
},

// Do: reject, so the resolve fails as one promise
resolveFunc: (path, c) => {
  if (!c.hasRegistered(Settings)) return Promise.reject(new Error('no settings'));
  return c.resolve(Settings).get(path);
},
```

## Related

- [Injection decorators](03-injection-decorators.md): the decorators built on these functions.
- [Named services](07-named-services.md): the lineage-aware alternative to `serviceFunc`.
- [Descriptor inheritance](14-descriptor-inheritance.md): own-metadata descriptors for your own decorator data.
- [`@spinajs/configuration`](../configuration/README.md): `@Config`, `@AutoinjectService` and `@AutoinjectNamedService`.
