# Fake adapters, contexts and recorders

In-memory stand-ins for everything a model reads and the host writes to: resource rows and their tree, scope nodes, relations, principal sources, the permission registry, the evaluation context, the decision audit, the change bus and the clock.

## How it works

1. A model under test gets an `EvaluationContext` per request. `fakeEvaluationContext(opts)` builds one over your adapters, scope resolvers and relations.
2. `ctx.ancestors(ref)` asks the adapter that serves `ref.type`, then the scope resolver that lists it, else returns the design default `[ref, GLOBAL]`. `ctx.attributes(ref)` follows the same order, with `{}` as the default.
3. Both are memoised per context and counted in `ctx.stats`, so a test can assert how often a model loaded a node.
4. `fakeModelInitContext(opts)` is the context of `model.init`: it records what the model registers.

## The fakes

| Export | Stands in for | Notes |
| --- | --- | --- |
| `FakeAdapter` | `ResourceAdapter<FakeRow>` | Rows per type, child → parent links, scope attributes, column relations. `rows(type, filter, env)` returns the rows a residual selects, by `evaluateFilter`. |
| `FakeScopeResolver` | `ScopeResolver` | A tree of scope nodes with attributes and per-type defaults (deep-merged under node attributes). |
| `FakeRelationResolver` | `RelationResolver` | `new FakeRelationResolver(type, relation, (principal, ref, subject?) => boolean)`; counts `calls`. |
| `FakePrincipalSource` | authz-http's `PrincipalSource` (structural mirror) | Looks a principal up by a header value (case-insensitive name), or calls `authenticate`; logs `requests`. Register it under authz-http's token yourself: the kit does not depend on authz-http. |
| `FakePermissionRegistry` | `PermissionRegistry` | `register(...defs)`, `get`, `require`, `match(glob)`, `impliedBy(name)`, `all()`. |
| `toPermissionDef(input, source = 'fake')` | | A name or a partial def → a frozen `PermissionDef` (`types` default `[resource]`). |
| `fakeEvaluationContext(opts)` | `EvaluationContext` | Adds `steps` (the `trace()` calls), `stats` and `nativeFilter(op)`. |
| `fakeModelInitContext(opts)` | `ModelInitContext` | Adds `registered.{permissions, nativeFilters, relations}`. |
| `ThrowingConditionCompiler` | `ConditionCompiler` | The context default: compiling a condition throws and tells you to pass `conditions`. |
| `RecordingAudit` | `DecisionAudit` | `entries` and `of(kind)`. |
| `RecordingChangeBus` | `ChangeBus` | `published`; fans out synchronously inside `publish()`, in subscription order. |
| `ManualClock` | the host clock (`AuthzClock`) | Starts at `new Date(0)` unless given a date; `now()`, `advance(ms)`, `set(date)`. |

### `FakeAdapter` options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `kind` | string | `'fake'` | |
| `types` | `ResourceType[]` | required | Types the adapter serves. |
| `rows` | `Record<type, FakeRow[]>` | `{}` | A row is `{ id, ...fields }`. |
| `parents` | `[child, parent][]` | `[]` | A parent need not be a row of this adapter. |
| `relations` | `(RelationResolver \| { type, relation, column })[]` | `[]` | The column form holds when `row[column] === principal.id`. |
| `attributes` | `[ref, attributes][]` | `[]` | Scope attributes; a known row without an entry has `{}`. |
| `compiles` | `FilterOp[]` | `CORE_FILTER_OPS` | Pass `compiles: undefined` explicitly for an adapter that is not list-scoped. |
| `permissions` | `PermissionDef[]` without `source` | `[]` | What `permissions()` declares. |

- `accepts(target)` is true only for row objects the adapter holds (by identity), not copies.
- `ancestors(ref)`: `[ref, …parents, GLOBAL]` for a known row, `[ref, GLOBAL]` for a type-level ref, `null` for an unknown row. A parent cycle throws.
- `add(type, row, parent?)`, `remove(type, id)` and `all(type)` (insertion order) change and read the rows.

### `fakeEvaluationContext` options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `domain` | string | `'root'` | |
| `now` | `Date` or `{ now(): Date }` | the real now | A clock is read once: `now` is per request. |
| `permissions` | `PermissionRegistry` or `FakePermissionInput[]` | `[]` | A list builds a `FakePermissionRegistry`. |
| `adapters`, `scopeResolvers` | lists | `[]` | Asked in that order for ancestors and attributes. |
| `relations` | `RelationResolver[]` | `[]` | Found before the adapters' relations. |
| `nativeFilters` | `NativeFilter[]` | `[]` | Served by `nativeFilter(op)`. |
| `conditions` | `ConditionCompiler` | `ThrowingConditionCompiler` | Pass `DefaultConditionCompiler` for ABAC-style conditions. |
| `check` | `(req) => Promise<Decision>` | rejects | The delegate a model calls through `ctx.check`. |
| `cache` | `Map` | a new `Map` | `ctx.cache`, shared by every check of one request. |

`fakeModelInitContext` takes `domain`, `config` (the model's `authz.<model>` section; `config(path)` reads a dotted path in it), `permissions` and `model`. Permissions the model registers get `source: 'model:<model>'` and are added to the registry when it is a `FakePermissionRegistry`.

## Important behaviour

- `RecordingChangeBus.publish()` rejects when a subscriber throws.
- `FakeScopeResolver.ancestors()` and `attributes()` return `null` for a node it never saw. A node is known once added or named as a parent.
- `FakePermissionRegistry.register` throws `AuthzConfigError` for a name registered twice; `require` throws `UnknownPermission`.
- `FakeAdapter.attribute(subject, field)` reads a dotted path over own properties only; prototype getters read as `undefined`.

## Best practices

- Hand a model one `fakeEvaluationContext` per request, as the engine does, and a new one for the next request: `ctx.cache` and the memo are per request.
- Use `ctx.stats.ancestors.loads` to assert that a model memoises ancestor reads.

## Examples

### Test a model's vote on a file below a project

```ts sample
import { FakeAdapter, FakeRbacModel, FakeScopeResolver, fakeEvaluationContext, userPrincipal } from '@spinajs/authz-testing';

const alice = userPrincipal('alice');
const p1 = { type: 'project', id: 'p1' };

const files = new FakeAdapter({
  types: ['file'],
  rows: { file: [{ id: 'f1', owner: 'alice' }, { id: 'f2', owner: 'bob' }] },
  parents: [
    [{ type: 'file', id: 'f1' }, p1],
    [{ type: 'file', id: 'f2' }, { type: 'project', id: 'p2' }],
  ],
  relations: [{ type: 'file', relation: 'owner', column: 'owner' }],
});
const projects = new FakeScopeResolver({ nodes: [{ ref: p1, parent: { type: 'org', id: 'o1' } }] });

const rbac = new FakeRbacModel({ roles: { member: ['file:read'] }, assignments: [{ subject: alice, role: 'member', scope: p1 }] });

export async function memberReadsOnlyProjectFiles(): Promise<[boolean, boolean]> {
  const ctx = () => fakeEvaluationContext({ adapters: [files], scopeResolvers: [projects], permissions: ['file:read'] });
  const f1 = await rbac.evaluate({ principal: alice, permission: 'file:read', resource: { type: 'file', id: 'f1' } }, ctx());
  const f2 = await rbac.evaluate({ principal: alice, permission: 'file:read', resource: { type: 'file', id: 'f2' } }, ctx());
  return [f1.permitWhen.op === 'true', f2.permitWhen.op === 'true']; // [true, false]
}
```

## Related

- [Fake models](03-fake-models.md): the models these fakes feed.
- [Reference residual evaluator](12-filter-oracle.md): what `FakeAdapter.rows()` uses to select rows.
- [Permission checks in app tests](01-permission-checks-in-app-tests.md): registering `RecordingAudit` in the host.
