# Behaviour harnesses

A harness turns a fixture's world into a running system, once per case, and hands the runner the handles its facets promise. Write one to run the behaviour fixtures against your model, store, adapter or app; start from `hostHarness` unless you test an engine of your own.

## How it works

1. `runBehaviour` calls your factory once and gets a `BehaviourHarness`: `facets`, an optional root `domain` name, optional `beforeAll`/`afterAll`, and `setup(world, ctx)`.
2. Per case, `setup` builds a fresh system for `world`. `instantiateWorld(world)` builds the kit fakes the world names (models, adapters, scope resolvers, relations, clock, audit, bus) as a `KitWorld`.
3. Your code maps the world onto the system under test and loads lane data (`world.rbac`, `world.abac`, `world.lane`) into your real models and stores.
4. `setup` returns a `HarnessSession`: `authz`, `kit`, and the handles of the declared facets (`audit`, `clock`, `bus`, `domains`, `admin`, `list`, `load`, `lane`), plus `dispose()`.
5. A `setup` that fails half-way cleans up what it built before it rejects: the runner disposes only sessions `setup` returned.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Harness | `BehaviourHarness` interface, one per `runBehaviour` call | `hostHarness(options)` | an engine harness of your own | Implement `setup`; or pass `register`/`extend` to `hostHarness`. |
| Lane handles | `LaneHandles` interface, filled per session in `session.lane` | the handles the kit's fixture files declare (`http`, `orm`, `fs`, `queue`, `rbacStore`, …) | | Your harness fills the handles of the facets it declares. A new handle is declared in the kit, by the fixture file that first needs it, augmenting `LaneHandles`. |
| Kit models in the host | `AuthorizationModel`, `ResourceAdapter`, `ScopeResolver`, `RelationResolver`, `DecisionAudit`, `ChangeBus`, `AuthzClock`, registered as instances in the test domain; models as named factories, listed in the test domain's `models` | `instantiateWorld` objects | | `hostHarness` registers them; your `register` hook adds the lane's own (`testHost.activate`). |

## `hostHarness`

`hostHarness(options)` gives each case a fresh test domain made by `AuthzDomains.create(<domain>, 'root')` and booted by the real `DefaultAuthzService`. It has the facets `engine`, `boot`, `audit`, `clock`, `cache`, `host` and `bus`, plus the ones in `options.facets`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `domain` | string | `'test'` | The test domain's name; also `$domain` in expected messages. |
| `facets` | `Facet[]` | `[]` | Facets the lane adds through `register`/`extend`. |
| `register(host)` | function | none | Lane wiring. Runs after the kit's registrations and before the case's first `service()`. |
| `extend(host, session)` | function | none | Extra session handles (`admin`, `list`, `lane`, …). A `dispose` it returns runs before the domain is disposed. |
| `kitScopeAttributes` | boolean | `true` | `false` skips the kit's `ScopeAttributeStore` and schema contributor, for a lane that registers its own. |

`host` (`HostSetup`) carries the test domain's `container`, the world domains' `containers`, `world`, `kit`, `ctx`, `domain` and `setConfig(path, value)`.

### World → system

| World key | Engine harness | `hostHarness` (test domain) |
| --- | --- | --- |
| `permissions` | `kit.permissions` | `authz.domains.<test>.permissions` |
| `combine` | the engine's routes | `authz.domains.<test>.combine` |
| `models` (kit specs) | `kit.models`, in order | those instances, registered as named factories under `AuthorizationModel` and listed in `authz.domains.<test>.models` |
| `adapters`, `scopes`, `relations` | `kit.adapters`, `kit.scopeResolvers`, `kit.relations` | registered as `ResourceAdapter`, `ScopeResolver`, `RelationResolver` |
| `now` | `kit.clock` | `kit.clock`, registered as `AuthzClock` |
| `domains` | — | `AuthzDomains.create(name, parent)` per entry, with its kit models (listed in its `models`), `combine` and `disable` |
| `rbac`, `abac`, `rebac` | — | your lane's real model named `rbac` / `abac` / `rebac`, loaded in `register` |
| `scopeAttributes` | — | the kit's `ScopeAttributeStore` and schemas, unless `kitScopeAttributes: false` |
| `config.engine`, `config.fields`, `config.cache`, `config.audit` | the engine's options | `authz.domains.<test>.*`; without the `cache` facet and without `config.cache`, `cache.maxEntries: 0` |
| `config.principals` | the engine's options | `authz.principals` (root only) |
| `config.<other>` (model sections, `admin`, `http`, `fs`, `token`, …) | — | `authz.<other>` |
| `config.domains` | — | `authz.domains.*`; the keys the harness derives win |
| `lane` | — | what your lane builds with its own decorators and classes |

Kit models arrive un-initialised: the host calls their `init` at boot, as for any model.

### Lane data and handles

`World.lane` (`LaneWorld`: `http`, `orm`, `fs`, `queue`, `configuration`, `socket`) holds what a lane builds, as data. The steps of a lane part are `do` steps that call `session.lane.<key>`. A step whose handle is missing fails and names it.

| Facet | Session handles | Lane handles (`session.lane.<key>`) |
| --- | --- | --- |
| `engine` | `authz`, `kit` | |
| `audit`, `clock`, `bus` | `audit`, `clock`, `bus` | |
| `host` | `domains`, `authz.current`, `authz.runAs` | |
| `links` | | `rbacLinks` |
| `admin` | `admin` | `adminEvents` |
| `store` | | `store`, `rbacStore` |
| `list` | `list` | |
| `sql` | `list` | `sqlPages` |
| `orm` | `load` (optional) | `orm` |
| `http` | | `http`; also `linkSource` and `adminHttp` |
| `fs`, `queue`, `socket`, `email`, `configuration`, `token`, `authn` | | the handle of the same name |
| `impersonation` | | `impersonationGuard` |

The lane types (`LaneWorld`, `HttpHandle`, `OrmHandle`, `LaneHandles`, …) come from the package root; importing any of them brings the `World.lane` and `LaneHandles` declarations along.

## Configuration

Inside `hostHarness`, write config only through `host.setConfig(path, value)`: the case's cleanup restores every key it set. A world section replaces your lane's section at that key for the case; it is not merged into it.

## Important behaviour

- Root boots once, inside the first case and under that case's config, and stays booted. Keep your models out of root, and expect a root-only world key (`config.principals`) to reach root only in the first case.
- `hostHarness` installs `testHost`'s `TestConfiguration` in `beforeAll` unless `testHost.installHost()` already ran, and removes it in `afterAll` only when it installed it.
- Register a child domain's models in `register`, not in `extend`: `extend` runs after the services booted.
- Return the very `KitWorld` as `session.kit` and run its models, not copies: `calls` steps and scripted `do` steps read those instances.
- `session.authz` needs `check`, `checkMany` and `explain`; other methods only when a step calls them.
- A lane with its own query side (`list`, `sql`) implements `session.list(principal, permission, type)` returning the ids of the world rows the residual selects.
- A harness for both this kit and `@spinajs/authn-testing` adapts authn's `FakeClock`: `{ now: () => c.now(), advance: (ms) => c.tick(ms) }`.

## Best practices

- One fresh system per case; create a test domain per case and register your models in it, so the child owns them.
- Child-only model classes must not carry `@Injectable(AuthorizationModel)`; register them imperatively in the child and list them in its `models` (`testHost.activate` does both).
- Uncache only the root types your harness causes to be created. Never call `DI.clearCache()`.
- Load the host from `@spinajs/authz` (the lib), never from authz `src`.

## Patterns and antipatterns

```ts
// Don't: extend runs after the domain booted, so the model is never routed
hostHarness({ extend: (host) => { testHost.activate(host.container, host.domain, model); return {}; } });

// Do
hostHarness({ register: (host) => { testHost.activate(host.container, host.domain, model); } });
```

## Examples

### An RBAC harness over in-memory stores

```ts sample
import { AuthzContributor } from '@spinajs/authz';
import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel } from '@spinajs/authz-rbac';
import { hostHarness, runBehaviour, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness } from '@spinajs/authz-testing';

export const rbacHarness = (): BehaviourHarness =>
  hostHarness({
    facets: ['rbac'],
    register(host) {
      const rbac = host.world.rbac ?? {};
      const model = new RbacModel({
        roles: new MemoryRoleStore(rbac.roles ?? [], rbac.ladders ?? []),
        assignments: new MemoryAssignmentStore(rbac.assignments ?? []),
        clock: host.kit.clock, // cache TTLs move with the case's advance steps
      });
      // Registered as a factory named 'rbac' and listed in the test domain's models.
      testHost.activate(host.container, host.domain, model);
      // A model built with new RbacModel(options) wires nothing, so the contributor is registered here.
      host.container.register(testHost.instance(new RbacContributor(model))).as(AuthzContributor);
    },
  });

runBehaviour(['B11.rbac', 'B12.rbac', 'B13.rbac'], rbacHarness, { strict: true, timeoutMs: 30_000 });
```

### An engine harness for a system of your own

```ts
import { instantiateWorld, runBehaviour } from '@spinajs/authz-testing';
import type { BehaviourHarness } from '@spinajs/authz-testing';

const engineHarness = (): BehaviourHarness => ({
  facets: ['engine', 'audit', 'clock'],
  async setup(world) {
    const kit = instantiateWorld(world);
    const authz = buildMySystem({            // your code
      permissions: kit.permissions,
      models: kit.models,
      adapters: kit.adapters,
      scopeResolvers: kit.scopeResolvers,
      relations: kit.relations,
      combine: world.combine,
      config: world.config,
      clock: kit.clock,
      audit: kit.audit,
    });
    return { authz, kit, audit: kit.audit, clock: kit.clock, dispose: async () => undefined };
  },
});

runBehaviour(['B01', 'B03', 'B04.core'], engineHarness);
```

## Related

- [Behaviour fixtures](09-behaviour-fixtures.md): selectors, facets and the rules.
- [Test host and DI isolation](05-test-host-and-di.md): `testHost`, `scopedContainer` and the DI rules behind them.
- [Writing fixtures](11-writing-fixtures.md): the world keys a harness maps.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): its test harnesses add `list`, links, rules and a database on top of this one.
