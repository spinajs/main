# `@spinajs/authz-testing`

Test kit for SpinaJS authorization: fakes, conformance suites, behaviour fixtures.

- Fakes: `StaticModel`, `FakeRbacModel`, `FakeTupleModel`, `FakeAdapter`, `FakeScopeResolver`,
  `FakeRelationResolver`, `FakePrincipalSource`, `RecordingAudit`, `RecordingChangeBus`, `ManualClock`,
  fake contexts, principal builders and `evaluateFilter` (the reference residual evaluator).
- fast-check arbitraries for principals, ceilings, filters, votes, role graphs and rules.
- Conformance suites for models and adapters.
- Behaviour fixtures B01–B46 (design §17) and `runBehaviour`.

## Behaviour fixtures

Every lane runs the B-rules it owns from its own package tests (plan §1 rule 4):

```ts
import { runBehaviour } from '@spinajs/authz-testing';

runBehaviour(['B11', 'B12', 'B07.rbac'], () => rbacHarness());
```

- `'B07'` runs every part of the rule, `'B07.rbac'` one part. Unknown ids and parts throw when the
  suite is registered.
- Mocha shows one `describe` per rule and per part and one test per case, titled with the part id
  (`B03.core deny-overrides: a deny beats a permit`), so a lane can grep its acceptance in the output.
- Each part needs a set of facets. A part the harness lacks facets for is a pending test naming them
  when reached through the bare id, and a failing test when named by its part id or with
  `{ strict: true }`. A part without cases yet is pending with a note saying who proposes them.
- `BEHAVIOUR_FIXTURES` holds the fixtures as data (`behaviour/Bxx-*.spec.ts`), `FACETS` says what each
  facet promises, `BEHAVIOUR_RULES` holds the rule texts of design §17.

A fixture depends on no engine or model code. A case is a `World` (data: permissions, `combine`, kit
model specs, adapters with rows, scope trees, principals, RBAC and ABAC data, config overrides) and a
list of steps (`check`, `filter`, `filterNow`, `agree`, `runAs`, `advance`, `publish`, `calls`,
`audit`, …), each with an expectation (allowed, reason code and payload, residual TRUE / FALSE /
conditional / the rows it selects, fields, validUntil, trace, thrown error name).

The fixtures hold every engine to these rules, which the design leaves implicit:

- Residuals are evaluated with SQL three-valued logic, as the kit's `evaluateFilter` does: a
  comparison with NULL or with a value of another type is UNKNOWN, `NOT UNKNOWN` is UNKNOWN, and a
  check with a subject is allowed, or a row selected, only when the residual is TRUE.
- The reported deny reason is the lowest `(priority, sortKey)` among all deny sources, the core's
  included: a ceiling or delegate deny (200) still lets the models report a lower one (an
  `agents_disabled` at 100). Only SYSTEM and UNATTENDED skip the models.
- A permitting vote without `fields` contributes every field, before `hide` and
  `authz.fields.neverRead`.
- `authz.engine.maxDelegation` counts `onBehalfOf` hops: an agent acting for a user is one.
- Of the tags of a cached decision, fixtures rely only on `subject:<principalKey>` of its principal
  and `model:<name>` of a model that voted (and on a model's `version()` change).
- An expected error message writes `$domain` where it names the domain; the runner puts in the name
  the harness gives (`domain`, default `'root'`).

## Writing a harness

A harness turns a world into a running system, once per case. It declares the facets it has and
returns a session holding the handles of those facets.

```ts
import { instantiateWorld, runBehaviour } from '@spinajs/authz-testing';
import type { BehaviourHarness } from '@spinajs/authz-testing';

// buildMySystem is the lane's own code.
const engineHarness = (): BehaviourHarness => ({
  facets: ['engine', 'audit', 'clock'],
  async setup(world) {
    // The kit fakes the world names (`world.models`, adapters, scope resolvers, relations).
    const kit = instantiateWorld(world);
    // Your lane's code: map the world onto the system under test.
    const authz = buildMySystem({
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

- `session.authz` needs `check`, `checkMany` and `explain` of `AuthzService`; the other methods
  (`filter`, `filterNow`, `can`, `assert`, `preload`, `models`, `current`, `runAs`, …) only when a
  step calls them.
- Return the `KitWorld` as `session.kit`, and run its models, not copies: `calls` steps and `do`
  steps that script a model read those very instances.
- A lane with a real model loads the world's data into it: `world.rbac` (roles, ladders,
  assignments, rules, links) for the model named `rbac`, `world.abac.policies` for `abac`. The kit
  models of `world.models` still come from `instantiateWorld`.
- Lanes with their own query side (`list`, `sql` facets) implement `session.list(principal,
  permission, type)` returning the ids of the world rows the residual selects; `session.load(ref)`
  returns what the lane's adapter loads for a row (an ORM instance).
- `beforeAll`/`afterAll` run once around the cases (bootstrap an app, open a database).
- A harness whose root is a test domain names it in `domain` (boot messages are matched against it).
- Lane handles (orm, http, fs, …) are declared by the fixture file that first needs them, by
  augmenting `LaneHandles`.

### World → system

Where each key of a `World` goes. "Engine" is an `Authorizer`-style harness (F3); "host" is a test
domain built from `AuthzService`/`AuthzDomains` (F4 and the lanes). The kit cannot import host code,
so a shared host harness helper comes with F4; until then each host lane follows this table.

| World key | Engine harness | Host harness (test domain) |
|---|---|---|
| `permissions` | `kit.permissions` (a `FakePermissionRegistry`) | `authz.permissions` config, or registered by the lane's models and adapters at boot |
| `combine` | the Authorizer's routes | `authz.combine` (or `authz.domains.<test>.combine` when the test domain is a child) |
| `models` (kit specs) | `kit.models`, in order | the very instances of `kit.models`, registered under `AuthorizationModel` in the test domain |
| `adapters` | `kit.adapters` | `kit.adapters` registered as `ResourceAdapter` in the test domain |
| `scopes` | `kit.scopeResolvers` | registered as `ScopeResolver` |
| `relations` | `kit.relations` | registered as `RelationResolver` |
| (native filters of kit models) | `kit.nativeFilters` | registered by the models' own `init` (`ctx.registerNativeFilter`) |
| `principals` | used by the steps only | used by the steps only |
| `now` | `kit.clock` as the time source | `kit.clock` as the host's clock |
| `domains` | — | `AuthzDomains.create(name, parent)` per entry, its kit models (`kit.domainModels.get(name)`) registered in that child, `combine` and `disable` as `authz.domains.<name>.*` |
| `rbac`, `abac`, `rebac` | — | the lane's real model named `rbac` / `abac` / `rebac`, loaded with this data |
| `scopeAttributes` | — | the lane's `ScopeAttributeStore` and schemas |
| `config.engine`, `config.fields`, `config.cache`, `config.audit`, `config.principals` | the Authorizer's options | the same keys under `authz.*` |
| `config.<model>` | — | the model's section (`authz.<model>.*`) |
| (audit, bus facets) | `kit.audit`, `kit.bus` | `kit.audit` and `kit.bus` registered as the host's `DecisionAudit` and `ChangeBus` |

Kit models arrive un-initialised: the system's boot calls their `init`, as it does for any model.

### DI rules for harness writers

- One fresh system per case; `dispose` is called after every case, also a failing one. The runner
  disposes only a session that `setup` returned: a `setup` that fails half-way cleans up what it
  built before it rejects (`scopedContainer` does this for its child).
- Create a test domain (child container) per case and register the lane's models in the child, so the
  child owns them: `scopedContainer({ register, resolve, uncache })`. Since DI-2 a root-registered
  singleton first resolved through a child lives in root and survives `child.dispose()` (F2 behaviour
  A).
- Child-only model classes must not carry `@Injectable(AuthorizationModel)`; register them
  imperatively in the child (F2 hand-off H, design §15.2).
- Uncache only the root types the harness causes to be created (`uncacheOwned`). Never call
  `DI.clearCache()`: it wipes entries other packages write at import time, which nothing rebuilds.

```ts
import { AuthzService } from '@spinajs/authz';
import { instantiateWorld, scopedContainer } from '@spinajs/authz-testing';
import type { BehaviourHarness } from '@spinajs/authz-testing';

const rbacHarness = (): BehaviourHarness => ({
  facets: ['engine', 'rbac'],
  domain: 'test',
  async setup(world) {
    const kit = instantiateWorld(world);
    const scope = await scopedContainer({
      register: (child) => registerMyRbacModel(child, world.rbac, kit), // the lane's own wiring
      resolve: (child) => child.resolve(AuthzService),
    });
    return { authz: scope.resolved, kit, domain: 'test', dispose: () => scope.dispose() };
  },
});
```

## Adding fixtures

A fixture file exports a `BehaviourFixture` (`fixtureDsl.fixture(id, parts)`) or, to add parts to a
rule another file defines, a `FixtureExtension` (`fixtureDsl.extension(id, parts)`); a part with cases
replaces a declared part of the same name that has none. Add the file to `behaviour/catalogue.ts`.
After G1 a lane does not edit this package: a broken fixture is an RFC.
