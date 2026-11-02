# Test host and DI isolation

Helpers that boot the authz host over an in-memory configuration and give each test a clean DI state without wiping what other packages registered at import time. `testHost` is a namespace, so short names such as `config` and `instance` stay out of the package root.

## How it works

1. `testHost.installHost()` remembers which host types root has already cached, registers `TestConfiguration` as `Configuration` (last, so it wins) and resolves it.
2. Tests write config through `testHost.config()` and register root services through `testHost.registerInRoot(token, factory)`.
3. The first resolve of `AuthzService` or `testHost.domains().service('root')` boots the root domain from that config.
4. `testHost.resetHost()` disposes the child domains and the root service, removes the root registrations the tests made and empties the config.
5. `testHost.uninstallHost()` does the same, uncaches only the host types that were not cached before install, and unregisters `TestConfiguration`.

## `testHost` functions

| Function | Effect |
| --- | --- |
| `installHost()` | Installs `TestConfiguration` and returns it; a second call returns the same instance. |
| `uninstallHost()` | Disposes domains and the root service, removes test registrations, uncaches what install created, unregisters `TestConfiguration`. |
| `resetHost()` | Between tests: no child domains, no root service, no test registrations, an empty config. |
| `config()` | The installed `TestConfiguration`; throws before `installHost()`. |
| `domains()` | Resolves `AuthzDomains` (must be `DefaultAuthzDomains`). |
| `rootDomains()` | The root `DefaultAuthzDomains` if root already created it, without creating it. |
| `disposeDomains()` | Disposes every live child domain. |
| `resetRoot()` | Disposes and uncaches the root `AuthzService`, so the next resolve boots root again. |
| `registerInRoot(token, factoryOrClass)` | Registers in root and returns a function that removes exactly that registration. |
| `instance(value)` | A factory for one instance: `container.register(testHost.instance(x)).as(Token)`. |
| `named(name, factory)` | Sets the factory's function name, which a `models` list activates it by: `container.register(testHost.named('A', testHost.instance(m))).as(AuthorizationModel)`. |
| `activate(container, domain, model)` | Registers `named(model.name, instance(model))` under `AuthorizationModel` in `container` (through `registerInRoot` in root, so `resetHost()` removes it) and appends `model.name` to the domain's models list: `authz.models` for `'root'`, else `authz.domains.<domain>.models`. |
| `TestConfiguration` | In-memory `Configuration`: `get`, `set`, `merge`, `unset`, `reset`; paths are dotted strings or segment arrays. |

## DI helpers

| Export | Effect |
| --- | --- |
| `scopedContainer({ parent?, register?, resolve, uncache? })` | Creates a child of `parent` (default root), registers `register` in it (a list of classes or `[impl, token]` pairs, or a function), resolves `resolve(child)`. Returns `{ container, resolved, dispose() }`. |
| `uncacheOwned(types, container = root)` | Drops the cached instances of the listed types from that container, nothing else. |

`dispose()` is idempotent. It calls `dispose()` once on every non-`Service` instance the child cached (models, stores), disposes the child, then uncaches `uncache` from the parent. A `resolve` that throws disposes the child before rejecting.

## Configuration helpers

For packages that test their own configuration schema:

| Export | Effect |
| --- | --- |
| `configurationOf(values)` | A `FrameworkConfiguration` class over `values` alone: no file or env source; only registered schemas validate and default it. |
| `bootConfiguration(values, schemas = [], parent = root)` | Registers `configurationOf(values)` and `schemas` in a fresh child of `parent` and resolves it. Returns `{ child, configuration }`; you dispose `child`. Rejects with `InvalidConfiguration` (after disposing the child) for a refused value. |
| `violationPaths(boot)` | Awaits a `bootConfiguration` promise and returns the `violations[].path` of its `InvalidConfiguration`; fails when it boots. |
| `bindConfiguration(instance, container)` | Makes the `@Config` properties of an object built with `new` read the configuration of `container`. |

See [schema validation](../configuration/06-schema-validation.md) for the schemas these helpers apply.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Test configuration | `Configuration`, singleton in root while installed | `TestConfiguration` | `configurationOf(values)` in a child (`bootConfiguration`) | Call `installHost()` before anything resolves `Configuration`. |

## Important behaviour

- A singleton registered in root and first resolved through a child lives in root and survives `child.dispose()`. A child never yields a fresh root singleton: register what must be fresh in the child.
- `registerInRoot`'s undo reaches into the DI registry internals. In behaviour harnesses prefer the harness's `register` hook.
- `uninstallHost()` leaves cached any host type that was cached before `installHost()`.
- `TestConfiguration` validates nothing; the host still reads its defaults for missing keys.

## Best practices

- Pair `installHost()` in `before` with `uninstallHost()` in `after`, and `resetHost()` or `resetRoot()` in `afterEach` when tests change root registrations.
- Uncache only types your test caused to be created (`uncacheOwned`, `scopedContainer({ uncache })`).
- Register child-only model classes imperatively in the child; they must not carry `@Injectable(AuthorizationModel)`. A registered model is only available: list its class (or `named()` factory) name in the domain's `models`, or use `testHost.activate`.

## Patterns and antipatterns

```ts
// Don't: wipes entries other packages write at import time, which nothing rebuilds
DI.clearCache();

// Do
uncacheOwned([MyStore]);
```

## Examples

### A model and its store in a disposable child container

```ts sample
import '@spinajs/di';
import { AuthorizationModel, TRUE } from '@spinajs/authz';
import { StaticModel, scopedContainer } from '@spinajs/authz-testing';

class InvoiceModel extends StaticModel {
  constructor() {
    super({ name: 'invoices', votes: { 'invoice:read': { permitWhen: TRUE } } });
  }
}

export async function isolatedModel(): Promise<void> {
  const scope = await scopedContainer({
    register: [[InvoiceModel, AuthorizationModel]],
    resolve: async (child) => await child.resolve(Array.chainOf(AuthorizationModel)),
  });
  try {
    console.log(scope.resolved.map((m) => m.name)); // includes 'invoices'
  } finally {
    await scope.dispose(); // calls InvoiceModel.dispose() once, then disposes the child
  }
}
```

### Assert that a schema refuses a value

```ts sample
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { IConfigurationSchema } from '@spinajs/configuration';

declare const INVOICES_SCHEMA: IConfigurationSchema;

export async function refusesNegativeLimit(): Promise<boolean> {
  const paths = await violationPaths(bootConfiguration({ invoices: { approvalLimit: -1 } }, [INVOICES_SCHEMA]));
  return paths.includes('invoices.approvalLimit');
}
```

## Related

- [Permission checks in app tests](01-permission-checks-in-app-tests.md): the host booted for an app check.
- [Behaviour harnesses](10-behaviour-harnesses.md): `hostHarness` and the DI rules for harness writers.
- [Child containers](../di/05-child-containers.md): how a child resolves and owns its instances.
