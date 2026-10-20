# Writing fixtures

A fixture case is data: a `World` (permissions, combining, kit models, rows, principals, model data, config) and a list of steps, each with an expectation. Write cases to add parts to a rule for your package, or to pin down a behaviour of your app the same way the kit pins the engine.

## How it works

1. A fixture file exports a `BehaviourFixture` (`fixtureDsl.fixture(id, parts)`) or, to add parts to a rule defined elsewhere, a `FixtureExtension` (`fixtureDsl.extension(id, parts)`).
2. A part has a `name` (selected as `B07.<name>`), the `facets` it needs, the plan `lanes` that own it, an optional `note`, an optional shared `world`, and `cases`.
3. `mergeFixtures` merges by id. Of two parts with one name, the one with cases replaces a declared one without; two with cases, or two without, throw.
4. The runner resolves `as: 'alice'` through `world.principals`, runs the steps against the session and compares each result with its expectation.

## The world

| Key | Meaning |
| --- | --- |
| `now` | Request time. Required when anything expires or the clock moves. |
| `permissions` | `FakePermissionInput[]`: names or partial defs. |
| `combine` | `{ default: { algorithm, models }, types? }`, as `authz.combine`. |
| `models` | Kit model specs, in registration order: `{ kind: 'static', name, ...StaticModel options }`, `{ kind: 'fake-rbac', ... }`, `{ kind: 'fake-tuple', ..., tuples? }`. All fake-tuple models of a world share one `FakeTupleStore`. |
| `adapters`, `scopes`, `relations` | `FakeAdapter` options, `FakeScopeResolver` options, `{ type, relation, holds }`. In a world with `rbac`, an adapter that leaves `compiles` out also compiles `native:rbac.assignment` and `native:rbac.threshold`. |
| `principals` | Principals by key, used by `as`, `actor`, `holder`, `target`. |
| `domains` | Child domains: `parent` (default `root`), `combine`, `models`, `disable`. |
| `rbac`, `abac`, `rebac`, `scopeAttributes` | Data for the lane's real models and stores: roles, ladders, assignments, rules, links; policies; tuples; attribute schemas and values. |
| `config` | Overrides of `authz.*`: `engine`, `fields`, `cache`, `audit`, `principals`, and model sections by name. |
| `lane` | Lane data (`http`, `orm`, `fs`, `queue`, `configuration`, `socket`), declared by the lane types. |

## Steps

| Step | Calls | `expect` |
| --- | --- | --- |
| `{ check: req }` | `authz.check` | `DecisionExpectation` or `Throws` |
| `{ explain: req }` | `authz.explain` | as `check` |
| `{ can: req }` | `authz.can` | boolean or `Throws` |
| `{ assert: req }` | `authz.assert` | as `check`; a deny throws `AccessDenied` |
| `{ checkMany: { as, permissions, resource?, domain? } }` | `authz.checkMany` | expectation per permission |
| `{ filter: { as, permission, type } }` | `authz.filter` | `ResidualExpectation` or `Throws` |
| `{ filterNow: ... }` | `authz.filterNow` | as `filter`, or `'undefined'` |
| `{ agree: { as, permissions, type } }` | B06: `check(subject = row).allowed` ⇔ row in the filter, for each principal, permission and row | none |
| `{ summary: { as, at? } }` / `{ covers: { holder, target, at? } }` | `authz.summary` / `authz.covers` | listed or absent permissions / boolean |
| `{ preload: who }`, `{ invalidate: tags }` | `authz.preload`, `authz.invalidate` | none |
| `{ advance: ms }` | `session.clock.advance` (clock facet) | none |
| `{ publish: { tags, domain?, actor? } }` | `session.bus.publish` (bus facet) | none |
| `{ runAs: { as, reason }, steps }` | nested steps under `authz.runAs` (host facet) | none |
| `{ current: who }`, `{ models: names }`, `{ disposeDomain: name }` | `authz.current`, `authz.models`, a child domain's dispose | |
| `{ calls: { model, method?, count?, atLeast?, lastArgs? } }` | the calls a kit `StaticModel` recorded | |
| `{ audit: { kind, reason?, permission?, principal?, count? } }` | `session.audit.entries` | |
| `{ published: { tags, count? } }` | `session.bus.published` | |
| `{ do: (ctx) => ..., note? }` | anything; use `node:assert` inside | |

A `CheckRequest` is `{ as, permission, resource?, subject?, actor?, env?, domain? }`. `subject: 'row'` passes the world row of `resource` (or what `session.load` returns for it). Without `resource` the check is type-level.

## Expectations

`DecisionExpectation` checks only the keys you give:

| Key | Meaning |
| --- | --- |
| `allowed` | The decision's `allowed`. |
| `reason` | A code, a subset of the reason's keys (`{ code: 'model_error', model: 'm1' }`), or `null` for no reason. |
| `residual` | `'TRUE'`, `'FALSE'`, `'conditional'`, `{ equals: filter }` (after `simplify`), or `{ selects: ids }` (the world rows the residual holds for, by `evaluateFilter`). |
| `fields` | `{ read?, write? }`, each `{ allows?, denies? }` field paths. |
| `roles` | Effective role per ladder. |
| `validUntil` | A date, or `null` for none. |
| `trace` | `true`/`false`, or `{ votes: models }`. |
| `actor`, `domain` | The decision's actor ref (or `null`) and domain (`$domain` allowed). |

`Throws` is `{ throws: 'AuthzConfigError', message?: [...] }`: the error class or an ancestor has that name, and each string appears in the message. A case with `boot: Throws` expects `setup` to reject; add `orAtCall: true` to also accept a setup that succeeds when a step then throws.

## `fixtureDsl` helpers

| Helper | Builds |
| --- | --- |
| `fixture(id, parts)`, `extension(id, parts)` | A fixture with the rule text from `BEHAVIOUR_RULES`, or an extension. |
| `combine(algorithm, ...models)` | One route for every type. `ALGORITHMS` lists the three algorithms. |
| `staticModel(name, opts)` | A `static` kit model spec. |
| `permit(when = TRUE, extra)`, `deny(reason?, when = TRUE, extra)` | Scripted votes; `deny` with a reason adds one `denies` entry. |
| `allRows()`, `ownedRows()`, `noRows(code)` | List plans for `ListStaticModel` specs (`ownedRows` emits `relation.owner`). |
| `cmp(field, op, value?)`, `relation(name)`, `under(...scopes)` | Residual nodes. |
| `ref(type, id?)`, `later(date, ms)` | Refs and dates. |
| `role(name, grants, extra)`, `assignment(id, subject, role, scope = GLOBAL, extra)` | RBAC data in authz-rbac's shapes. |

`laneSteps` and `modelSteps` hold the `do` step helpers of the lane and model fixtures, under namespaces so short names stay out of the package root. Examples: `laneSteps.as(who, ...steps)`, `laneSteps.http(call, expect)`, `laneSteps.orm(query, expect)`, `laneSteps.accessibleAgree(req)`, `laneSteps.versionAs(key)` / `versionChanged(key, changed)`; `modelSteps.exec(as, commands, outcome)` (runs `AuthzAdmin` commands), `modelSteps.checks(source, specs)`, `modelSteps.mark(name)` / `since(name, e)`, `modelSteps.impersonates(actor, target, e)`.

## Validation

| Export | Effect |
| --- | --- |
| `validateWorld(world, { lenient? })` | Problems that make a world a broken fixture; `[]` when well-formed. `lenient` skips the checks boot rules own, for worlds meant to fail boot. |
| `validateCase(case, partWorld?)` | Problems of one case: its world, the references its steps make, and expectations that would pass whatever the system does. |
| `instantiateWorld(world)` | The kit fakes of a world, as new objects on every call. |
| `selectRows(kit, residual, type, principal, actor?)` | Ids of the kit rows the residual is TRUE for. |
| `resolvePrincipal(world, who)` | A world principal by key, or the principal given. |

## Important behaviour

- A fixture depends on no engine or model code; only the harness does.
- Expected messages write `$domain` where they name the domain: test domains are rarely called `root`.
- A part with no cases runs as pending with its `note`; under `strict` it fails.
- Export names follow D-F5-11: `Bxx` for a rule's own fixture, `Bxx<Part>` in PascalCase for an extension (`B02Lanes`, `B06Rules`).

## Best practices

- Add lane-local parts in your package with `extension` and pass them through `opts.fixtures`; do not fork the kit's catalogue.
- End each case with a control step that is allowed, so a system that denies everything does not pass.
- Run `validateCase` over your local cases in a plain test: it catches unknown principals and expectations that cannot fail.

## Examples

### A lane-local part: a frozen invoice is denied with its reason

```ts sample
import { BEHAVIOUR_FIXTURES, fixtureDsl, hostHarness, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { Case, World } from '@spinajs/authz-testing';

const world: World = {
  permissions: ['invoice:approve'],
  principals: { alice: userPrincipal('alice') },
  combine: fixtureDsl.combine('deny-overrides', 'm1', 'm2'),
  models: [
    fixtureDsl.staticModel('m1', { votes: { 'invoice:approve': fixtureDsl.permit() } }),
    fixtureDsl.staticModel('m2', { votes: { 'invoice:approve@invoice:7': fixtureDsl.deny({ code: 'frozen', priority: 300 }) } }),
  ],
};

const cases: Case[] = [
  {
    name: 'a frozen invoice is denied with its reason',
    world,
    steps: [
      { check: { as: 'alice', permission: 'invoice:approve', resource: fixtureDsl.ref('invoice', '7') }, expect: { allowed: false, reason: { code: 'frozen', model: 'm2' } } },
      { audit: { kind: 'deny', reason: 'frozen', count: 1 } },
      { check: { as: 'alice', permission: 'invoice:approve', resource: fixtureDsl.ref('invoice', '8') }, expect: { allowed: true, reason: null } },
    ],
  },
];

const LOCAL = [fixtureDsl.extension('B03', [{ name: 'invoices', facets: ['engine', 'audit'], lanes: ['app'], cases }])];

runBehaviour(['B03.invoices'], () => hostHarness(), { strict: true, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
```

## Related

- [Behaviour fixtures](09-behaviour-fixtures.md): running the catalogue.
- [Behaviour harnesses](10-behaviour-harnesses.md): where each world key goes in your system.
- [Fake models](03-fake-models.md): the options of the kit model specs.
