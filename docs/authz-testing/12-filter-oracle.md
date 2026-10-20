# Reference residual evaluator

`evaluateFilter(filter, subject, env)` evaluates a residual (`ResourceFilter`) against one row and returns `true`, `false` or `null` (UNKNOWN). It is the kit's oracle: the conformance suites, `FakeAdapter.rows()`, `selectRows` and the `selects` expectation all decide with it what a residual must select. Use it to check your own query side or a model's residual by hand.

## How it works

1. You pass the residual, the loaded row (`subject`) and a `FilterEnv` naming the principal and the row's `ref`.
2. `and`, `or` and `not` are evaluated in Kleene logic; leaves (`cmp`, `relation`, `under`, native ops) resolve through the env, else through `env.context`.
3. The result is a `Kleene` (`boolean | null`). `isAllowed(result)` is `result === true`: UNKNOWN never allows.

## `FilterEnv`

| Key | Default | Meaning |
| --- | --- | --- |
| `principal` | required | Holder of `relation` ops and root of `principal.*` refs. |
| `actor` | the principal | Root of `actor.*` refs. |
| `ref` | required | The row's ref: what `under`, `relation` and native filters see. |
| `env` | none | Root of `env.*` refs. |
| `ancestors(ref)` | the context's, else `[ref, GLOBAL]` | For `under` and `scope.<type>.*` refs. |
| `attributes(ref)` | the context's, else `{}` | Scope attributes for `scope.<type>.*` refs. |
| `relation(type, name)` | the context's | The `RelationResolver` of a `relation` op. |
| `nativeFilters` | the context's `nativeFilter(op)` | Evaluators of `native:*` ops. |
| `attribute(subject, field)` | dotted path over own properties | The in-memory `cmp` read. |
| `context` | an empty `fakeEvaluationContext` | Handed to native filters. |

## Semantics

- Empty `and` is TRUE, empty `or` is FALSE.
- `cmp` on a NULL or missing field is UNKNOWN, except `null` and `notnull`, which are two-valued.
- `eq`, `ne`, `in`, `nin` with a literal `null` are UNKNOWN (never `IS NULL`). `in []` is FALSE and `nin []` is TRUE whatever the field holds.
- A canonical number string compares with a number as that number; a boolean equals `0` or `1` for `eq`, `ne`, `in`, `nin`. Any other type mismatch is UNKNOWN, and stays UNKNOWN under `not`: negation never turns it into access.
- Dates compare as ISO strings. An invalid `Date` field is NULL; one outside years 0000-9999 is not comparable.
- Strings order by code point (SQLite `BINARY`, Postgres `COLLATE "C"`); booleans do not order.
- `like` follows Postgres: case-sensitive, `%` any run, `_` one code point, `\` escapes; a lone trailing `\` is UNKNOWN.
- `glob`: `*` is a run without `/`, `**` any run. `wildcard`: `*` is any run, `/` included.
- `{ ref }` values: `principal.*`, `actor.*`, `env.*`, `scope.<type>.<path>` (the nearest ancestor of that type). An unresolved, null, object-valued or malformed ref is UNKNOWN.
- A `relation` without a resolver, a native op without a filter, and `under` on a row with unknown ancestors are UNKNOWN. `under []` is FALSE. A scope without `id` matches any ancestor of its type.
- Unknown ops and comparators throw `TypeError`; resolver and native filter errors propagate.

## Important behaviour

- These are the semantics the behaviour fixtures hold every engine to (B06): a check with a subject is allowed, or a row selected, only when the residual is TRUE.
- An SQL query side must match it, NULLs and LIKE escapes included; the `compiles` check of [adapter conformance](07-adapter-conformance.md) compares the two.

## Examples

### Which open or own files does a residual select

```ts sample
import type { ResourceFilter } from '@spinajs/authz';
import { FakeAdapter, evaluateFilter, fakeEvaluationContext, isAllowed, userPrincipal } from '@spinajs/authz-testing';

const files = new FakeAdapter({
  types: ['file'],
  rows: { file: [{ id: 'a', status: 'open', owner: 'bob' }, { id: 'b', status: null, owner: 'alice' }, { id: 'c', status: 'locked', owner: 'bob' }] },
  relations: [{ type: 'file', relation: 'owner', column: 'owner' }],
});

const residual: ResourceFilter = { op: 'or', args: [{ op: 'cmp', field: 'status', cmp: 'eq', value: 'open' }, { op: 'relation', relation: 'owner' }] };

export async function selected(): Promise<string[]> {
  const alice = userPrincipal('alice');
  const context = fakeEvaluationContext({ adapters: [files] });
  const out: string[] = [];
  for (const row of files.all('file')) {
    if (isAllowed(await evaluateFilter(residual, row, { principal: alice, ref: { type: 'file', id: row.id }, context }))) out.push(row.id);
  }
  return out; // ['a', 'b']
}
```

## Related

- [Adapter conformance](07-adapter-conformance.md): compares your query side with this oracle.
- [Model conformance](06-model-conformance.md): reads model residuals on rows with it.
- [Fake adapters, contexts and recorders](04-fake-adapters-and-contexts.md): `FakeAdapter.rows()` selects with it.
