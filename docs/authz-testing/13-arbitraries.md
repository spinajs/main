# Arbitraries

fast-check generators for authorization data: principals, ceilings, permissions, residual filters and rows, votes and deny reasons, RBAC role graphs, ladders, rules and assignments, scope trees, tuple graphs, and whole ORM access worlds. They live in the `arb` namespace (`import { arb } from '@spinajs/authz-testing'`). Use them for property tests of your model, store or query side, and as `seeds` of [model conformance](06-model-conformance.md).

## How it works

1. Each generator takes an options object and returns an `fc.Arbitrary`.
2. Pool options follow one rule: absent means the default pool, `[]` means none. A generator that can do without a pool drops the part that needs it; one that cannot throws.
3. Default pools are small on purpose, so generated values collide often: ids `a`-`d`, types `org`, `project`, `file`, `dir`, roles `viewer`, `editor`, `manager`, `owner`, `guest`.
4. Dates fall within 30 days of `now` when you give one, else between 2020 and 2035.

## Generators

| Generator | Produces | Main options |
| --- | --- | --- |
| `arb.principal(opts)` | Frozen principals built with the kit's builders; `system` and `unattended` only when named in `kinds` | `kinds`, `ceiling`, `attributes`, `ids`, `now` |
| `arb.principalRef(opts)` | `{ type, id }` refs, default types `user`, `service`, `group`, `link` | `kinds`, `ids` |
| `arb.resourceRef(opts)` | Resource refs, type-level ones too unless `typeLevel: false` | `types`, `ids`, `typeLevel` |
| `arb.ceiling(opts)` | Ceilings: roles, permission globs, resources, expiry, reason | `roles`, `permissions`, `maxLength`, `now` |
| `arb.permissionName(opts)`, `arb.permissionGlob(opts)` | Valid names and globs | `pool` |
| `arb.filter(opts)` | Residuals | `depth` (3), `width` (3), `fields`, `values`, `relations`, `scopes`, `nativeOps`, `ops`, `comparators`, `refs`, `malformed` |
| `arb.row(opts)` | `FakeRow`s over the same fields and values a filter draws from; fields may be missing or null | `fields`, `values`, `ids` |
| `arb.vote(opts)`, `arb.denyReason(opts)` | Votes (an `error` about one time in ten) and deny reasons | filter options, `now` |
| `arb.roleGraph(opts)`, `arb.ladder(opts)` | RBAC roles with `extends` (acyclic by default; `dangling: true` also names roles that do not exist), and a ladder with its roles, weakest first | `roles`, `maxExtends`, `acyclic`, `dangling`, grant options |
| `arb.cap(opts)`, `arb.restriction(opts)` | RBAC rules of kind `cap` and `restrict` | `ladders`, `roles`, `scopes`, `principalTypes`, `now` |
| `arb.assignment(opts)` | RBAC assignments to user, service, group and link refs, and to subject sets unless `sets: false` | `subjects`, `roles`, `scopes`, `sets`, `now` |
| `arb.scopeTree(opts)` | A tree of scope nodes with `parents`, `rows` and `scopeNodes` ready for `FakeAdapter` and `FakeScopeResolver` | `types`, `depth`, `width`, `minRoots` |
| `arb.tupleGraph(opts)` | Acyclic tuple graphs under `TUPLE_GRAPH_SCHEMA`, within `maxDepth` | `folderDepth` (3), `groupDepth` (2), `width` (3), `users`, `maxDepth` (8) |
| `arb.accessWorld(opts)` | A behaviour `World` with org > project > doc ORM data and RBAC assignments | `now`, `maxDocs` (6) |

`arb` also holds the constants these use: `COMPARATORS`, `DEFAULT_REFS`, `TUPLE_GRAPH_SCHEMA`, `TUPLE_GRAPH_PERMISSIONS`, `ACCESS_PERMISSIONS` and `ACCESS_ROLES`.

### `accessWorld`

`ACCESS_PERMISSIONS` (`doc:read`, `doc:update`, `project:read`, all `list: true`) and `ACCESS_ROLES` are also exported from the package root:

| Role | Grants |
| --- | --- |
| `viewer` | `doc:read`, `project:read` |
| `editor` | `doc:read`, `doc:update`, `project:read` |
| `author` | `doc:read` and `doc:update` on docs the user owns (`relation: 'owner'`) |
| `blocked` | denies `doc:read` at its scope and below (`deny: true`) |

Each world holds users `alice`, `bob` and `carol`; ORM models `Org`, `Project` and `Doc` with `@Parent` chains and `@Owner` on docs; up to 8 unique assignments at `$global`, org, project or doc scope, to a user or `user:*`, live, expired or expiring later; combined `deny-overrides` over the model `rbac`. B06 over the ORM holds for every such world.

## Important behaviour

- Field pools may not hold array-index segments such as `tags.0`: they resolve in memory but cannot be written in SQL, so the generators throw.
- Scope tree ids are `<type><n>` and never meet the default id pool: pass `scopes: tree.nodes` to filters, rules and assignments that must touch a generated tree.
- `tupleGraph` leaves cycles to hand-written tests; its `depthBound` never exceeds `maxDepth`, so no `FakeTupleModel` vote is indeterminate.
- `arb.filter({ malformed: true })` sometimes draws bad literal lists, junk scalars and malformed refs, for the fail-closed paths of `bindRefs` and `evaluateFilter`.

## Examples

### Seed model conformance with a random grantee

```ts sample
import { GLOBAL } from '@spinajs/authz';
import type { PrincipalRef } from '@spinajs/authz';
import { FakeAdapter, FakeRbacModel, arb, runModelConformance, userPrincipal, worldRows } from '@spinajs/authz-testing';
import type { ModelFactory } from '@spinajs/authz-testing';

const p1 = { type: 'project', id: 'p1' };

// The seed is the user who also gets viewer at p1.
const factory: ModelFactory<PrincipalRef> = ({ seed, shuffle }) => {
  const files = new FakeAdapter({ types: ['file'], rows: { file: [{ id: 'f1' }, { id: 'f2' }] }, parents: [[{ type: 'file', id: 'f1' }, p1]] });
  const model = new FakeRbacModel({
    roles: { viewer: ['file:read'], editor: ['file:*'] },
    assignments: shuffle([
      { subject: seed, role: 'viewer', scope: p1 },
      { subject: { type: 'user', id: 'dave' }, role: 'editor', scope: GLOBAL },
    ]),
  });
  return {
    model,
    world: {
      principals: ['alice', 'bob', 'carol', 'dave'].map((id) => userPrincipal(id)),
      permissions: ['file:read', 'file:write'],
      rows: worldRows(files),
      context: { adapters: [files], permissions: ['file:read', 'file:write'] },
    },
    mutations: [
      {
        title: 'assign erin viewer at p1',
        request: { principal: userPrincipal('erin'), permission: 'file:read', resource: { type: 'file', id: 'f1' }, subject: files.all('file')[0] },
        after: true,
        apply: () => {
          model.assign({ subject: { type: 'user', id: 'erin' }, role: 'viewer', scope: p1 });
        },
        freshness: 'version',
      },
    ],
  };
};

runModelConformance('FakeRbacModel with a random viewer', factory, { seeds: arb.principalRef({ kinds: ['user'], ids: ['alice', 'bob', 'carol'] }) });
```

## Related

- [Model conformance](06-model-conformance.md): `seeds` and the factory's `seed`.
- [Principal builders](02-principals.md): what `arb.principal` builds with.
- [Fake models](03-fake-models.md): `FakeTupleModel` for `tupleGraph` worlds.
