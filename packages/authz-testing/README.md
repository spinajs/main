# `@spinajs/authz-testing`

Test kit for SpinaJS authorization: fakes, conformance suites, behaviour fixtures.

- Fakes: `StaticModel`, `FakeRbacModel`, `FakeTupleModel`, `FakeAdapter`, `FakeScopeResolver`,
  `FakeRelationResolver`, `FakePrincipalSource`, `RecordingAudit`, `RecordingChangeBus`, `ManualClock`,
  fake contexts, principal builders and `evaluateFilter` (the reference residual evaluator).
- fast-check arbitraries for principals, ceilings, filters, votes, role graphs and rules, exported under
  the `arb` namespace (`import { arb } from '@spinajs/authz-testing'`, then `arb.filter`, `arb.principal`, …).
- Conformance suites for models and adapters.
- Behaviour fixtures B01–B46 (design §17) and `runBehaviour`.

## Client access conformance

`runClientAccessConformance(name, harness)` checks a running app against the client access API
(design 2026-10-14 §10): `POST /user/access/checks` with the request bodies of ckit's
`createHttpChecker`, `$access` on a list route, `X-Access-Epoch` and `GET /user/access/events`. The
harness starts the app holding `CLIENT_ACCESS_FIXTURE` (users `me` and `other`, docs 1-4, the roles and
assignments listed there, `GET /docs` as `.accessible('doc:view').withAccess(['doc:edit', 'doc:view'])`)
and returns `{ baseUrl, headers(id), assign(id, role, scope), stop() }`. The checks run in order; `push`
changes data and runs last.

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
- A harness for both this kit and `@spinajs/authn-testing` adapts authn's `FakeClock` to the kit's
  `BehaviourClock`: `{ now: () => c.now(), advance: (ms) => c.tick(ms) }` (`FakeClock.now()` returns a `Date`).
- `beforeAll`/`afterAll` run once around the cases (bootstrap an app, open a database).
- A harness whose root is a test domain names it in `domain` (boot messages are matched against it).
- Lane handles (orm, http, fs, …) are declared by the fixture file that first needs them, by
  augmenting `LaneHandles`; "Lane data and handles" below lists them.

### World → system

Where each key of a `World` goes. "Engine" is an `Authorizer`-style harness (F3); "host" is a test
domain built from `AuthzService`/`AuthzDomains` (F4 and the lanes). `hostHarness` ("Shared host
harness" below) does the host column for the kit's keys; a lane adds its own keys (`rbac`, `abac`,
`scopeAttributes` with its own store, `lane`) through its options. `<test>` is the test domain's name;
the test domain is a child of root.

| World key | Engine harness | Host harness (test domain) |
|---|---|---|
| `permissions` | `kit.permissions` (a `FakePermissionRegistry`) | `authz.domains.<test>.permissions`, or registered by the lane's models and adapters at boot |
| `combine` | the Authorizer's routes | `authz.domains.<test>.combine` |
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
| `config.engine`, `config.fields`, `config.cache`, `config.audit` | the Authorizer's options | `authz.domains.<test>.*` (the host reads these keys per domain); without the `cache` facet and without `config.cache`, `hostHarness` sets `cache.maxEntries: 0` |
| `config.principals` | the Authorizer's options | `authz.principals` (root only) |
| `config.<model>` | — | the model's section (`authz.<model>.*`) |
| `config.admin`, `config.impersonation` | — | `authz.admin.*` (AdminGuard options, command permissions) and `authz.impersonation.*` (users' impersonation guard) |
| `config.http`, `config.fs`, `config.token` | — | `authz.http.*`, `authz.fs.*`, `authz.token.*` |
| `config.domains` | — | `authz.domains.*`; the keys `hostHarness` derives for `<test>` and the world's domains win |
| `lane` | — | what the lane builds with its own decorators and classes (routes, ORM models, filesystems, jobs, configuration rows, socket handlers); see "Lane data and handles" |
| (audit, bus facets) | `kit.audit`, `kit.bus` | `kit.audit` and `kit.bus` registered as the host's `DecisionAudit` and `ChangeBus` |

Kit models arrive un-initialised: the system's boot calls their `init`, as it does for any model.

### Lane data and handles

`World.lane` holds what a lane builds, as data (`LaneWorld`: `http`, `orm`, `fs`, `queue`,
`configuration`, `socket`). The steps of a lane part are `do` steps that call the lane handles in
`session.lane`. A harness fills the handles of the facets it declares; a step whose handle is missing
fails and names it.

| Facet | Session handles | Lane handles (`session.lane.<key>`) |
|---|---|---|
| `engine` | `authz`, `kit` | — |
| `boot` | (`setup` rejects) | — |
| `audit` | `audit` | — |
| `clock` | `clock` | — |
| `cache` | — | — |
| `host` | `domains`, `authz.current`, `authz.runAs` | — |
| `bus` | `bus` | — |
| `rbac`, `ladders`, `rules`, `abac`, `conditions`, `rebac`, `scopeAttributes` | — (world data in the lane's models) | — |
| `links` | — | `rbacLinks` |
| `admin` | `admin` | `adminEvents` |
| `store` | — | `store`, `rbacStore` |
| `list` | `list` | — |
| `sql` | `list` | `sqlPages` |
| `orm` | `load` (optional) | `orm`: `.accessible()`, `.withAccess()`, the runtime guard |
| `http` | — | `http`; also `linkSource` (L5) and `adminHttp` (C4) |
| `fs` | — | `fs` |
| `queue` | — | `queue` |
| `socket` | — | `socket` |
| `email` | — | `email` |
| `configuration` | — | `configuration` |
| `token` | — | `token` |
| `authn` | — | `authn` (login, MFA completion, role switch, impersonation start) |
| `impersonation` | — | `impersonationGuard` |
| `canvas` | — | declared by K1 |

- The types come from the package root (`LaneWorld`, `HttpHandle`, `OrmHandle`, `LaneHandles`, …);
  importing any of them brings the `World.lane` and `LaneHandles` declarations along. The step
  helpers are under `laneSteps` and `modelSteps`.
- ORM queries, fs calls, `queue.emit` and `email.send` run in the current ALS (cases wrap them in
  `runAs`); `queue.handle` runs outside any ALS, as a consumer does.
- `OrmModelSpec.json` names the JSON columns; their row values are JSON text.
- `store.version` steps read the runner's root domain (the one `$domain` stands for) unless they name one.

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

### Shared host harness

`hostHarness(options)` is the harness every host lane starts from (F4 wrote it for its own host
tests). Each case gets a fresh test domain, made by `AuthzDomains.create(<test>, 'root')` and booted
by the real `DefaultAuthzService`, holding the world's kit fakes, audit, bus and clock. It has the
facets `engine`, `boot`, `audit`, `clock`, `cache`, `host` and `bus`, plus the ones in `facets`.

```ts
import { AuthorizationModel } from '@spinajs/authz';
import { hostHarness, runBehaviour, testHost } from '@spinajs/authz-testing';

runBehaviour(
  ['B11', 'B12', 'B13'],
  () =>
    hostHarness({
      facets: ['rbac'],
      // After the kit's registrations, before the case's first service().
      register(host) {
        // RbacModel and storeHandle are the lane's own code.
        host.container.register(testHost.instance(new RbacModel(host.world.rbac))).as(AuthorizationModel);
        host.setConfig(['authz', 'rbac', 'roles'], host.world.rbac?.roles ?? []);
      },
      // Extra session handles; a `dispose` it returns runs before the domain is disposed.
      extend: (host) => ({ lane: { rbacStore: storeHandle(host.container) } }),
    }),
  { strict: true },
);
```

- Options: `domain` (default `test`; `$domain` in expected messages), `facets`, `register(host)`,
  `extend(host, session)`, and `kitScopeAttributes: false` for a lane that registers its own
  `ScopeAttributeStore`. `host` (`HostSetup`) carries the test domain's `container`, the world
  domains' `containers`, `world`, `kit`, `ctx`, `domain` and `setConfig(path, value)`.
- Write config only through `host.setConfig`: the case's cleanup restores every key it set. A world
  section replaces the lane's section at that key for the case; it is not merged into it.
- Root boots once, inside the first case and under that case's config, and stays booted. Keep the
  lane's models out of root (register them in the test domain), and expect a root-only key of a world
  (`config.principals`) to reach root only in the first case.
- Load the host from the lib (`@spinajs/authz`, which this kit imports), never from authz `src`: two
  copies register two `DefaultAuthzService` classes in one DI root.
- Register a child domain's models before the first `service()` of that domain: `register` runs
  before the harness asks for the services, so register there, not in `extend`.
- `AuthzDomains.create` needs the DI `Configuration`: the harness installs `testHost`'s
  `TestConfiguration` in `beforeAll` unless `testHost.installHost()` already ran, and removes it in
  `afterAll`. A lane that uses the harness has no `Configuration` of its own; it writes config
  through `host.setConfig`.
- Uncache only what you created: `testHost.registerInRoot` returns its own undo, and
  `testHost.uninstallHost` uncaches only the root types it found uncached. Never call
  `DI.clearCache()`.
- `testHost` also holds the helpers F4's host tests use without the harness: `installHost`,
  `uninstallHost`, `resetHost`, `config`, `domains`, `rootDomains`, `disposeDomains`, `resetRoot`,
  `registerInRoot`, `instance`.

## Adding fixtures

A fixture file exports a `BehaviourFixture` (`fixtureDsl.fixture(id, parts)`) or, to add parts to a
rule another file defines, a `FixtureExtension` (`fixtureDsl.extension(id, parts)`); a part with cases
replaces a declared part of the same name that has none. Add the file to `behaviour/catalogue.ts`.
After G1 a lane does not edit this package: a broken fixture is an RFC.

## Decisions

Binding readings of the design that the fixtures rely on. Fixture notes cite them by id.

- D-F5-1: the reported deny reason is the lowest `(priority, sortKey)` among all deny sources, the core's
  included. A ceiling or delegate deny (200) does not stop model evaluation; `agents_disabled` (100)
  beats `ceiling`. SYSTEM and UNATTENDED skip the models.
- D-F5-2: a permitting vote without `fields` contributes all fields (`*`) before `hide` and
  `authz.fields.neverRead` apply.
- D-F5-3: `maxDelegation` counts hops; an agent acting for a user is one hop.
- D-F5-4: L2 invalidation tags are the design's names. A fixture asserts only that a decision is dropped
  by `subject:<principalKey>`, by `model:<name>` of a model that voted, and by a model `version()` change.
- D-F5-5: a residual evaluated against a subject uses SQL three-valued logic; UNKNOWN does not allow.
- D-F5-6: error-message expectations never hard-code the domain name; the runner substitutes `$domain`.
- D-F5-7: the AdminGuard does not run `covers` on a revoke; the last-holder and self-lockout checks still
  apply. SYSTEM passes the permission check and the guard.
- D-F5-8: `Decision.roles` (effective role per ladder) is filled for every outcome, denials included.
- D-F5-10: facet `authn` covers authentication flows (login, MFA completion, role switch, whoami);
  `impersonation` covers the impersonation guard only.
- D-F5-11: fixture export names are `Bxx` for a rule's own fixture and `BxxPart` in PascalCase for an
  extension (`B02Lanes`, `B06Rules`).
