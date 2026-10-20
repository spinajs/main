# Fake models

Four `AuthorizationModel` implementations for tests: a scripted model, a scripted model with list plans, a tiny role map and an in-memory ReBAC model. Register them where a real model would go, or hand them to the conformance suites and behaviour worlds.

## How it works

1. You build the model with its options; nothing is read from config or DI.
2. The host (or your test) calls `init(ctx)`, then `applies(permission, type)` to route it, then `evaluate(req, ctx)` per check.
3. The model answers with a `Vote` (`permitWhen`, `denyWhen`, `reason`, `cacheable`), and `StaticModel` records the call in `calls`.
4. `version()` changes when the model's data changes, so the host drops cached decisions and recompiles routes.

## The models

| Model | Name default | Use it for | Capabilities |
| --- | --- | --- | --- |
| `StaticModel` | `static` | Exact votes per permission and resource; failure modes (throw, `error`, delay) | effects `permit`, `deny`; residuals `CORE_FILTER_OPS`; `sync: 'always'`, `'never'` with `delayMs > 0` |
| `ListStaticModel` | `static` | A `StaticModel` that also answers `listSupport` and `listPlan` | as `StaticModel` |
| `FakeRbacModel` | `rbac` | Granting roles to principals at scopes | effect `permit`; residuals `true`, `false`, `and`, `or`, `relation`, `under`; `sync: 'always'` |
| `FakeTupleModel` | `rebac` | Relationship-based access over a `FakeTupleStore` | effect `permit`; residuals `CORE_FILTER_OPS` and `native:fake.tuple`; `sync: 'never'` |

### `StaticModel`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | `'static'` | The name `authz.combine` routes. |
| `capabilities` | `Partial<ModelCapabilities>` | see table above | Merged over the defaults. A vote function that returns a promise needs `sync: 'never'`. |
| `applies` | `{ permissions?, types? }` or `(def, type) => boolean` | every route | Permission globs and types, both optional, AND-ed. `types` also sets `capabilities.resourceTypes`. |
| `votes` | `VoteTable` or `VoteFn` | `{}` | The script. A missing key is no opinion (`permitWhen` and `denyWhen` `FALSE`). |
| `error` | string | none | Set on every vote: the vote is indeterminate (B04). |
| `throws` | unknown | none | Thrown by `evaluate` instead of voting. |
| `delayMs` | number | none | Delay before the vote; `Infinity` never settles (exercises `authz.engine.modelTimeoutMs`). |
| `summary` | object or function | `{ permissions: [] }` | What `summarize` returns (for `covers` and `summary`, B26). |

- `VoteTable` keys are tried in order: `'<permission>@<resourceKey>'`, `'<permission>@<type>'`, `'<permission>'`, `'*'`.
- A scripted vote (`ScriptedVote`) is used as given. Only `model`, `permitWhen` and `denyWhen` (`FALSE`), and `cacheable` (`true`) are filled when left out. With `denies` and no `denyWhen`, `denyWhen` is the OR of `denies[].when`.
- `calls` lists every `init`, `evaluate`, `preload`, `summarize`, `invalidate`, `dispose` and `listPlan` call with its arguments. `requests` and `invalidations` filter it.
- `respond(votes)` replaces the script; `bump()` changes `version()`.

### `ListStaticModel`

Adds `lists: { [permission]: ModelListPlan | (principal, type, req) => ModelListPlan }`. `listSupport` is `true` for exactly those permissions and a reason otherwise; `listPlan` throws `AuthzConfigError` for any other. A plain `StaticModel` has no `listSupport`, so boot rule 12 refuses it for a `list: true` permission.

### `FakeRbacModel`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | `'rbac'` | |
| `roles` | `Record<role, FakeGrant[]>` | required | A grant is a permission glob, or `{ permission, relation }` to permit only where the principal holds `relation` on the row. |
| `assignments` | `FakeAssignment[]` | `[]` | `{ subject, role, scope? }`; `scope` defaults to `GLOBAL`. |

- It is a role map, not RBAC: no `extends`, ladders, rules or expiry. A role assigned at `GLOBAL` or at an ancestor of the resource permits its grants.
- A scope without `id` matches any node of its type.
- The principal and its `companions` speak.
- A concrete request reads `ctx.ancestors`; unknown ancestors give a denial with reason `unknown_resource`. A type-level request answers synchronously with `under` over the assignment scopes (`TRUE` for `GLOBAL`).
- `applies` is true for a permission that some role grant matches.
- `assign(a)` and `revoke(a)` change `version()`. `summarize` lists the permissions of the live assignments, conditional for relation grants.

### `FakeTupleModel` and `FakeTupleStore`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | `'rebac'` | |
| `store` | `FakeTupleStore` | required | The tuples. Every write bumps the model's `version()`. |
| `schema` | `FakeTupleSchema` | required | Per type: `relations` (`relation → 'user \| group#member'`) and `permissions` (`permission → 'editor \| viewer \| parent->view'`). |
| `permissions` | `Record<permission, string>` | required | Maps an authz permission to `'<type>#<relation or permission>'`, e.g. `'file:read': 'file#view'`. |
| `maxDepth` | number | `8` | Nested relation evaluations; the requested one is depth 0. |

- A concrete request gets a definite vote from a breadth-first walk; cycles contribute nothing.
- A type-level request gets the residual `{ op: 'native:fake.tuple', args: { relation, principal } }`. `init` registers the `NativeFilter` that answers it per row with the same walk.
- Past `maxDepth` the vote is indeterminate (`error`, reason `model_error`) and the native filter answers `false`. Never put this residual under `not`.
- An unknown relation or permission in the schema or the mapping throws `AuthzConfigError` in the constructor.
- `FakeTupleStore` implements `TupleStore` (`read`, `reverse`, `write(add, remove, actor)` returning a version) and adds `objects(type)`, `onWrite(fn)` and a `writes` log. `Tuple` and `TupleStore` are the shape reserved for a later `@spinajs/authz-rebac`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Fake model | `AuthorizationModel`; none of the fakes carries `@Injectable` | none | the four models above | Register an instance: `container.register(testHost.instance(model)).as(AuthorizationModel)`. Subclass `StaticModel` to add `listSupport`/`listPlan` (authz-orm's tests do). |

## Important behaviour

- `StaticModel.evaluate` is synchronous unless `delayMs` is set or the vote function returns a promise.
- `respond()` keeps `version()`. The host's L2 cache then serves old decisions until `bump()`.
- Fakes are not initialised by the kit. The host calls `init` at boot, as for any model; `FakeTupleModel` registers its native filter there.
- An adapter serving a type that `FakeTupleModel` routes must list `FAKE_TUPLE_OP` in `compiles` (`[...CORE_FILTER_OPS, FAKE_TUPLE_OP]`). `FakeAdapter`'s default leaves it out, so the boot capability check refuses a list-scoped type.
- Combined with other models under deny-overrides or first-applicable, a `FakeTupleModel` past `maxDepth` makes the check refuse a row another model's residual still lists. Keep tuple graphs within `maxDepth` where models are combined.

## Patterns and antipatterns

```ts
// Don't: the default capabilities claim sync: 'always', and a promise-returning vote function breaks that claim
new StaticModel({ votes: async () => ({ permitWhen: TRUE }) });

// Do
new StaticModel({ capabilities: { sync: 'never' }, votes: async () => ({ permitWhen: TRUE }) });
```

## Examples

### Deny locked documents with a reason, permit the rest

```ts sample
import { TRUE } from '@spinajs/authz';
import type { ResourceFilter } from '@spinajs/authz';
import { StaticModel } from '@spinajs/authz-testing';

const locked: ResourceFilter = { op: 'cmp', field: 'status', cmp: 'eq', value: 'locked' };

export const documents = new StaticModel({
  name: 'documents',
  applies: { permissions: ['doc:*'] },
  votes: {
    'doc:read': { permitWhen: TRUE },
    'doc:update': { permitWhen: TRUE, denies: [{ when: locked, reason: { code: 'locked', priority: 300 } }] },
    'doc:delete@doc:archive': { permitWhen: TRUE },
  },
});
```

### Folder sharing with a ReBAC model

```ts sample
import { FakeTupleModel, FakeTupleStore } from '@spinajs/authz-testing';

export async function sharedFolder(): Promise<FakeTupleModel> {
  const store = new FakeTupleStore();
  const model = new FakeTupleModel({
    store,
    schema: {
      folder: { relations: { parent: 'folder', viewer: 'user' }, permissions: { view: 'viewer | parent->view' } },
      doc: { relations: { parent: 'folder', viewer: 'user' }, permissions: { view: 'viewer | parent->view' } },
    },
    permissions: { 'doc:read': 'doc#view', 'folder:read': 'folder#view' },
  });
  await store.write(
    [
      { object: { type: 'folder', id: 'reports' }, relation: 'viewer', subject: { type: 'user', id: 'alice' } },
      { object: { type: 'doc', id: 'q3' }, relation: 'parent', subject: { type: 'folder', id: 'reports' } },
    ],
    [],
    { type: 'user', id: 'admin' },
  );
  return model; // alice may doc:read doc:q3 through the parent arrow
}
```

## Related

- [Fake adapters, contexts and recorders](04-fake-adapters-and-contexts.md): the adapter, scope resolver and context the models read.
- [Model conformance](06-model-conformance.md): every fake passes it; your own model must too.
- [Behaviour fixtures](09-behaviour-fixtures.md): worlds name the fakes as data (`kind: 'static' | 'fake-rbac' | 'fake-tuple'`).
- [`@spinajs/authz` model contract](../authz/01-check-flow.md#concepts): votes, residuals and capabilities.
