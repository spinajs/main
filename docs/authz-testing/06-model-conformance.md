# Model conformance

`runModelConformance` checks any `AuthorizationModel` against the model contract: honest capabilities, the `sync` claim, residuals that agree with concrete votes on every row, freshness after a data change, and determinism. Run it for every model you write, and for every store you put behind an existing model (a custom `AssignmentStore` behind `RbacModel`, a `PolicyStore` behind `AbacModel`).

## How it works

1. `runModelConformance(name, factory, opts)` registers a mocha `describe(name)` with one `it` per check. Call it at the top level of a test file.
2. Each check calls your `factory({ seed, shuffle })` for a fresh `ModelSetup`: the model, a world (principals, permissions, rows, context) and optional mutations. With `opts.seeds` the seed comes from that fast-check arbitrary; `shuffle` fixes the load order of your data.
3. The suite calls `model.init` with a `fakeModelInitContext` over `world.context.permissions` and `world.config`, then computes the routes: every world permission × type in its `types` that `model.applies` accepts.
4. It samples principal × route × row requests (concrete, with subject, and type-level) in contexts built by `fakeEvaluationContext` at `CONFORMANCE_NOW` (`2026-01-01T00:00:00.000Z`) unless the world sets `now`.
5. A check fails with an `AssertionError` naming the request, both answers and, for a property, `replay with { seed: N }`.
6. After each check the suite calls `model.dispose()`, then `setup.dispose()`.

## The checks

| Id | What it holds the model to |
| --- | --- |
| `capabilities` | Capabilities are well-formed, and `applies` keeps to `resourceTypes`. |
| `init` | `init` registers well-formed permissions, native filters and relations; every declared native op has a filter. |
| `votes` | Votes use only declared ops and effects, and honour `fields`, `needsSubject` and `principalTypes`. Indeterminate votes fail unless `indeterminate: 'allow'`. |
| `sync` | The `sync` claim holds for type-level requests, and votes in a shared (preloaded) context equal the fresh votes. |
| `agreement` | The type-level residual agrees with the concrete vote on every row, with and without a subject. |
| `invalidate` | After each mutation the answers change as the model promises (`live`, `version` or `invalidate`), on the list side too. |
| `determinism` | Votes are deterministic, and the deny reason does not depend on load order. |

`modelConformanceChecks(factory, opts)` returns the same checks as `ConformanceCheck` objects (`id`, `title`, `run()`), to run outside mocha or one at a time.

## Configuration

`ModelConformanceOptions`:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `seeds` | `fc.Arbitrary<S>` | one world, seed `undefined` | any arbitrary | Random worlds. Required when the factory reads `seed`. |
| `numRuns` | number | `25` (at most `10` for checks that sample no requests) | ≥ 1 | Runs per property. |
| `samples` | number | `12` | ≥ 1 | Requests sampled per run. |
| `seed` | number | random | | fast-check seed, to replay a failure. |
| `indeterminate` | string | `'forbid'` | `'forbid'`, `'allow'` | `'allow'` accepts `error` votes and throws as failing closed. |
| `skip` | `ModelCheckId[]` | `[]` | check ids | Registered as pending. |
| `timeoutMs` | number | inherited, at least `20000` | ms | Mocha timeout per check. |

`ModelSetup`:

| Key | Meaning |
| --- | --- |
| `model` | A fresh model; the suite calls `init` and `dispose`. |
| `world.principals` | Who asks. Add principals outside `capabilities.principalTypes` to test that claim. |
| `world.actors` | `[principal, actor]` pairs, for models that read `req.actor` or emit `actor.*` refs. |
| `world.permissions` | Permissions asked about; each must be registered in `world.context.permissions` or by the model's `init`. |
| `world.rows` | Concrete resources and their loaded rows; `worldRows(fakeAdapter)` builds them. |
| `world.context` | `fakeEvaluationContext` options; give `permissions` as a list, not a shared registry. |
| `world.buildContext` | Builds a request's context from those options (default `fakeEvaluationContext`). |
| `world.env`, `world.config` | The request env, and the model's `authz.<model>` section handed to `init`. |
| `mutations` | Data changes with a probe whose answer flips; see below. |
| `dispose()` | Releases stores and connections; called after `model.dispose()`. |

`ModelMutation`: `title`, `request` (a concrete request with its `subject`), `after` (the probe's answer after the change; before it must be the opposite), `apply()`, `tags`, and `freshness`:

- `live`: the probe answers anew as soon as `apply` resolves.
- `version`: `version()` changes and the probe answers anew; the suite recompiles routes only then.
- `invalidate`: the probe may stay stale until the host calls `invalidate(tags)`; the suite calls it with `tags`.

## Important behaviour

- `sync` is a claim about type-level requests only (no resource id), the ones `filter`, `filterNow` and the synchronous ORM hook ask. `'always'`: `evaluate` returns a `Vote`, not a thenable. `'after-preload'`: the same once `preload` resolved in that context. `'never'`: no claim.
- Residuals are read in Kleene logic: UNKNOWN does not allow. An `error` vote or a throw is indeterminate and fails closed.
- A `needs_subject` vote without the subject is not indeterminate. It must fail closed through its residuals (deny `TRUE`, permit `FALSE`); it may permit fewer rows than the answer with the subject.
- A model without the `permit` effect never allows on its own; the suite reads its answer as "not denied".
- A second setup of the same seed is asked rows before type-level requests. A memo that lives across requests must key on everything the answer depends on.
- After a mutation, every principal × route × row must answer as a second setup where the change was applied before `init`. So `apply` must also work on a model that is not initialised yet.
- A factory without `mutations` fails the `invalidate` check; pass `skip: ['invalidate']` for a model that holds no data.
- The factory must be deterministic for a seed and order, and two setups of one seed must not share mutable stores: the determinism check holds two at once.

## Best practices

- Start from `FakeAdapter` rows with parents and an owner column, as the RBAC and ABAC suites do; add `FakeScopeResolver` nodes for scopes that are not rows.
- Pass the data your store loads through `shuffle`, so the determinism check compares two load orders.
- Add at least one mutation per freshness your model claims; one that grants and one that revokes.
- A real ABAC-style model needs `world.context.conditions` (e.g. `DefaultConditionCompiler`); the default compiler throws.

## Examples

### Check a custom assignment store behind `RbacModel`

```ts sample
import { GLOBAL } from '@spinajs/authz';
import type { Assignment } from '@spinajs/authz-rbac';
import { MemoryAssignmentStore, MemoryRoleStore, RbacModel } from '@spinajs/authz-rbac';
import { FakeAdapter, runModelConformance, userPrincipal, worldRows } from '@spinajs/authz-testing';
import type { ModelFactory } from '@spinajs/authz-testing';

// The store under test; it extends MemoryAssignmentStore here to keep the sample short.
class TeamAssignmentStore extends MemoryAssignmentStore {}

const p1 = { type: 'project', id: 'p1' };
const PERMISSIONS = [
  { name: 'file:read', types: ['file'] },
  { name: 'file:write', types: ['file'] },
];

const factory: ModelFactory = ({ shuffle }) => {
  const store = new TeamAssignmentStore(
    shuffle<Assignment>([
      { id: 'a1', subject: { type: 'user', id: 'alice' }, role: 'editor', scope: GLOBAL, source: 'test' },
      { id: 'a2', subject: { type: 'user', id: 'bob' }, role: 'viewer', scope: p1, source: 'test' },
    ]),
  );
  const files = new FakeAdapter({ types: ['file'], rows: { file: [{ id: 'f1' }, { id: 'f2' }] }, parents: [[{ type: 'file', id: 'f1' }, p1]] });
  return {
    model: new RbacModel({
      roles: new MemoryRoleStore([
        { name: 'viewer', extends: [], assignable: true, source: 'test', grants: [{ permission: 'file:read' }] },
        { name: 'editor', extends: ['viewer'], assignable: true, source: 'test', grants: [{ permission: 'file:write' }] },
      ]),
      assignments: store,
      log: { warn: () => undefined },
    }),
    world: {
      principals: ['alice', 'bob', 'carol'].map((id) => userPrincipal(id)),
      permissions: PERMISSIONS.map((p) => p.name),
      rows: worldRows(files),
      context: { adapters: [files], permissions: PERMISSIONS },
    },
    mutations: [
      {
        title: 'assign carol viewer at p1',
        request: { principal: userPrincipal('carol'), permission: 'file:read', resource: { type: 'file', id: 'f1' }, subject: files.all('file')[0] },
        after: true,
        apply: () => store.add({ id: 'a3', subject: { type: 'user', id: 'carol' }, role: 'viewer', scope: p1, source: 'test' }),
        tags: ['subject:user:carol'],
        freshness: 'invalidate',
      },
    ],
  };
};

runModelConformance('RbacModel over TeamAssignmentStore', factory, { timeoutMs: 120_000 });
```

With random worlds, pass `seeds` (a fast-check arbitrary, or one from [the `arb` namespace](13-arbitraries.md)) and read `seed` in the factory: `ModelFactory<Seed>`.

## Related

- [Fake models](03-fake-models.md): `StaticModel`, `FakeRbacModel` and `FakeTupleModel` pass this suite in the kit's own tests.
- [Adapter conformance](07-adapter-conformance.md): the same idea for `ResourceAdapter`.
- [Reference residual evaluator](12-filter-oracle.md): how the suite reads residuals on rows.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md) and [`@spinajs/authz-abac`](../authz-abac/README.md): run this suite over `RbacModel` and `AbacModel`.
