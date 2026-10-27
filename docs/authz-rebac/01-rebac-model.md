# The ReBAC model

`RebacModel` is the `AuthorizationModel` that answers from relation tuples. A permission maps to a relation or permission of a namespace (`'doc:read': 'doc#view'`); a check asks whether the principal holds it on the requested object, walking tuples under the namespace's rewrites.

## How it works

### Wiring

1. The app builds a `RebacModel`, registers it as a named factory under `AuthorizationModel` in the domain's container and lists that name in the domain's `models` ([Models by name](../authz/05-domains.md#models-by-name)), with its store registered as `TupleStore` when admin commands should write to it.
2. The host calls `init(ctx)`:
   1. The limits: `limit` option, else `authz.<name>.limit`, else `maxDepth: 8`, `maxCalls: 10000`. Each must be a positive integer (`AuthzConfigError`).
   2. The namespaces and the permission map: the `namespaces` and `permissions` options, else `authz.<name>.namespaces` and `authz.<name>.permissions`. They compile into a `NamespaceSchema`; any problem fails the boot ([Namespaces](02-namespaces.md#boot-checks)).
   3. The store: the `store` option, else the `TupleStore` registered in the domain container, else the one `authz.<name>.store` names (`DbTupleStore` by default, or `MemoryTupleStore`).
   4. It registers the `NativeFilter` of `native:rebac.check`.
3. The first `applies()` checks that every permission of the map is registered (`UnknownPermission`). After that `applies(permission, type)` is true when the map sends the permission to that type.

| Option | Default | |
| --- | --- | --- |
| `name` | `'rebac'` | The model reads `authz.<name>.*`; its votes and tags carry the name. |
| `store` | domain `TupleStore`, else `authz.<name>.store` | Where the tuples are read. |
| `namespaces` | `authz.<name>.namespaces` | See [Namespaces](02-namespaces.md). |
| `permissions` | `authz.<name>.permissions` | Permission to `<namespace>#<name>`. |
| `limit` | `authz.<name>.limit`, then `{ maxDepth: 8, maxCalls: 10000 }` | |

### A check

`check(object, name, principal)` answers `member`, `not` or `unknown`:

- A **relation** reads the tuples of `object#name`. A direct subject equal to the principal (type and id) whose type the relation admits is `member`. A subject set `X#r` the relation admits is checked one hop deeper: `check(X, r)`.
- A **computed userset** checks another name of the same object, at the same depth.
- A **tuple-to-userset** `ts->c` reads the tuples of `object#ts` and checks `c` on every object they name (a subject `{ type, id }` of an admitted namespace type), one hop deeper.
- **union**: `member` if any branch is, else `unknown` if any is, else `not`. **intersection**: `not` if any branch is, else `unknown` if any is, else `member`. **exclusion** `base - subtract`: `not` when base is `not` or subtract is `member`, `member` when base is `member` and subtract is `not`, else `unknown`.

Only what the namespaces admit is followed (Keto's strict mode): a tuple written to the store directly with a subject type its relation does not list grants nothing.

### Limits

- **Depth**: the requested object is at depth 0; a subject set or a tuple-to-userset edge adds one hop; computed usersets and set operators add none. A node past `limit.maxDepth` is not read and makes its branch `unknown`, so a proof within `maxDepth` hops is always found and a check whose only proof is deeper is refused.
- **Calls**: past `limit.maxCalls` node evaluations in one check, the check stops (`RebacLimitExceeded`).
- **Cycles**: a node already on the current path answers `not`, so nested groups that name each other end without a grant and without an error.
- Answers are memoised per node and depth within a check; tuple reads are memoised per request in `ctx.cache`.

### Votes

| Request | Vote |
| --- | --- |
| Concrete resource, `member` | `permitWhen: TRUE` |
| Concrete resource, `not` | `permitWhen: FALSE`, reason `no_access` |
| Concrete resource, `unknown` or past `maxCalls` | indeterminate: `error` (`rebac: maxDepth 8 exceeded at group:g3#member`), reason `model_error`; fails closed (B04) |
| Type-level `{ type }` | `permitWhen: { op: 'native:rebac.check', args: { relation, principal } }` |
| Permission not mapped to the type | `permitWhen: FALSE`, reason `no_access` |

The model never denies: its effects are `['permit']`. Combine it with deny-capable models (ABAC) for vetoes.

`capabilities`: `effects: ['permit']`, `residuals`: the core ops and `native:rebac.check`, `sync: 'never'`, `fields: false`, `needsSubject: false`, `resourceTypes`: the namespaces the permission map targets.

### Freshness

Checks always read the store, so a tuple change is live for the next request. `version()` is the hash of the namespaces and the permission map plus a generation that moves on every `MemoryTupleStore` write and on `invalidate` with `*`, `rebac`, `rebac:<namespace>` or `model:<name>`; the tuple commands publish those tags, so decision caches drop.

## Examples

```ts sample
import { fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import { MemoryTupleStore, RebacModel } from '@spinajs/authz-rebac';

export async function canRead(): Promise<boolean> {
  const store = new MemoryTupleStore([
    { object: { type: 'doc', id: 'd1' }, relation: 'parent', subject: { type: 'folder', id: 'f1' } },
    { object: { type: 'folder', id: 'f1' }, relation: 'viewer', subject: { type: 'user', id: 'carol' } },
  ]);
  const model = new RebacModel({
    store,
    permissions: { 'doc:read': 'doc#view' },
    namespaces: {
      folder: { relations: { viewer: ['user'] } },
      doc: { relations: { parent: ['folder'] }, permissions: { view: 'parent->viewer' } },
    },
  });
  await model.init(fakeModelInitContext({ permissions: [{ name: 'doc:read', types: ['doc'] }] }));
  return (await model.check({ type: 'doc', id: 'd1' }, 'view', userPrincipal('carol'))) === 'member';
}
```

## Edge cases

- `summarize` is not implemented: summaries and `covers` see no ReBAC permissions.
- Principal companions and wildcard subjects (`user:*`) are not matched; only the principal itself is.
- A tuple-to-userset follows object subjects only; a subject set in a tupleset is ignored.
- The native residual answers `false` for an indeterminate row, so never put it under `not`.

## See also

- [Namespaces](02-namespaces.md)
- [Lists](04-lists.md)
- [Writing a model](../authz/08-writing-a-model.md)
