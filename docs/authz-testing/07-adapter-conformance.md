# Adapter conformance

`runAdapterConformance` checks any `ResourceAdapter` against the adapter contract: declarations, `refOf` and `ancestors`, loaded data, relations, and `compiles` honesty. The last check is the B06 check ⇔ filter hook: for random residuals over the ops the adapter claims, its query side must return exactly the rows the kit's oracle accepts.

## How it works

1. `runAdapterConformance(name, factory, opts)` registers a mocha `describe(name)` with one `it` per check.
2. Each check calls `factory()` once for an `AdapterSetup` (an SQL lane seeds one database per check, not per filter) and calls `setup.dispose()` at the end.
3. The suite resolves every target with `accepts` and `refOf`, then runs the check.
4. For `compiles`, it generates filters from the claimed ops, the setup's `fields`, `values`, `refs`, the targets' relations and ancestor scopes, and native leaves. It binds refs with `bindRefs`, as `AuthzService.filter` hands them over.
5. For each filter, principal and type it compares `setup.query(filter, q)` with `evaluateFilter` over every target. A difference fails with the missing and extra rows and the filter.

## The checks

| Id | What it holds the adapter to |
| --- | --- |
| `declarations` | `kind`, `types`, `permissions()`, `operations()`, `relations()` and `compiles` are well-formed; no type or relation twice. |
| `refs` | `accepts` refuses junk values; `refOf` gives a typed ref with an id; `ancestors` is `[self, …, GLOBAL]` without repeats for every target, and `null` for unknown refs. |
| `data` | `load`, `attribute` and `scopeAttributes` agree with the targets; unknown refs give `null`. |
| `relations` | Each relation answers a boolean for every target of its type, the same with and without the subject. |
| `compiles` | For filters over the claimed ops, the query returns exactly the rows the oracle accepts. With `compiles` undefined the setup must give no `query`. |

`adapterConformanceChecks(factory, opts)` returns the same checks as `ConformanceCheck` objects.

## Configuration

`AdapterConformanceOptions`:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `numRuns` | number | `60` | ≥ 1 | Generated filters for `compiles`. |
| `seed` | number | random | | fast-check seed, to replay a failure. |
| `depth` | number | `3` | ≥ 1 | Nesting of generated filters. |
| `skip` | `AdapterCheckId[]` | `[]` | check ids | Registered as pending. |
| `timeoutMs` | number | inherited, at least `20000` | ms | Mocha timeout per check. |

`AdapterSetup<T>`:

| Key | Meaning |
| --- | --- |
| `adapter` | The adapter under test. |
| `targets` | Every object it serves (rows, model instances). |
| `principals` | Who the `compiles` check filters as. |
| `unknown` | Refs the adapter must not know; default one per type with id `conformance-missing-0`. |
| `fields` | Fields `load`/`attribute` must agree on and `cmp` filters read; default none. |
| `values` | Literals for `cmp` filters; default the scalar values of `fields` in the targets. Add LIKE and glob metacharacters (`%`, `_`, `*`, `\`) for an SQL adapter. |
| `refs` | `{ ref }` values for `cmp` filters, default `['principal.id']`. Add `env.*` and `scope.<type>.<path>` refs. |
| `nativeFilters`, `nativeLeaves` | In-memory evaluators for the native ops in `compiles`, and generated native nodes with meaningful args. |
| `context` | Scope resolvers, other adapters and extra relations for the oracle's context. |
| `env` | The request env handed to `bindRefs` and the query. |
| `query(filter, { principal, type, env })` | The query side: the refs of `type` your query language selects. Required when `compiles` is set. |
| `dispose()` | Closes what the setup opened. |

## Important behaviour

- A native op in `compiles` needs an in-memory evaluator in `nativeFilters` (design §6.5.4); otherwise the oracle reads it as UNKNOWN and selects nothing.
- The query side gets filters with refs already bound, except `scope.<type>.*` refs, which the query side resolves itself.
- `values` default to what the targets hold; an SQL adapter that does not escape LIKE metacharacters passes until you add them.

## Best practices

- Seed the database from the same rows you list in `targets`, once per `factory()` call.
- Put rows with `null` and missing fields in the targets: the oracle uses SQL three-valued logic, and the query must too.

## Examples

### The kit's in-memory adapter against its own query side

```ts sample
import { FakeAdapter, runAdapterConformance, userPrincipal } from '@spinajs/authz-testing';
import type { AdapterSetup } from '@spinajs/authz-testing';

const p1 = { type: 'project', id: 'p1' };

function setup(): AdapterSetup {
  const adapter = new FakeAdapter({
    types: ['file'],
    rows: { file: [{ id: 'a', owner: 'alice', status: 'open' }, { id: 'b', owner: 'bob', status: null }] },
    parents: [[{ type: 'file', id: 'a' }, p1]],
    relations: [{ type: 'file', relation: 'owner', column: 'owner' }],
  });
  return {
    adapter,
    targets: adapter.all('file'),
    principals: [userPrincipal('alice'), userPrincipal('bob')],
    fields: ['owner', 'status'],
    values: ['alice', 'bob', 'open', 'op%', 'a_', '\\'],
    query: async (filter, { principal, type, env }) => (await adapter.rows(type, filter, { principal, env })).map((r) => ({ type, id: r.id })),
  };
}

runAdapterConformance('FakeAdapter over files', setup);
```

### The shape of an SQL adapter's setup

```ts
runAdapterConformance('DocAdapter on SQLite', async () => {
  const db = await openTestDb();                 // your code
  await db.insert('docs', DOC_ROWS);
  const adapter = new DocAdapter(db);            // the adapter under test
  return {
    adapter,
    targets: await adapter.loadAll(),
    principals: [userPrincipal('alice'), userPrincipal('bob')],
    fields: ['owner', 'status'],
    values: ['alice', 'open', 'lock%', 'op_n', 'a*', '\\'],
    refs: ['principal.id', 'env.owner'],
    env: { owner: 'bob' },
    query: async (filter, q) => adapter.selectRefs(filter, q),   // compile to SQL and run it
    dispose: () => db.close(),
  };
});
```

## Related

- [Reference residual evaluator](12-filter-oracle.md): the oracle the `compiles` check compares against.
- [Fake adapters, contexts and recorders](04-fake-adapters-and-contexts.md): `FakeAdapter` and its options.
- [Model conformance](06-model-conformance.md): the matching suite for models.
- [`@spinajs/authz-orm` access lists](../authz-orm/01-access-lists.md): the ORM's query side for residuals.
