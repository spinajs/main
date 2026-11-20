# Lists

Two list paths read this model: the engine's type-level residuals (`filter()`, `filterNow()`, memory adapters) and the list plans of `.accessible()` in `@spinajs/authz-orm`.

## How it works

### Residuals

A type-level request gets `{ op: 'native:rebac.check', args: { relation, principal } }`. The native filter `init` registers runs the same check per row, so it covers every rewrite, exclusion included. An adapter that serves a routed type must list `native:rebac.check` in its compiled ops.

### List plans

`listSupport(permission, type)` is `true` unless the mapped name reaches an exclusion (through computed names, subject sets or tuple-to-userset targets); then it answers a reason, and boot rule 12 refuses that permission as `list: true` on the type.

`listPlan` expands, from the principal's side and within `limit.maxDepth` hops, the subject sets the principal belongs to and the objects it reaches through each tupleset, and emits one term:

```ts
{ kind: 'terms', permit: [{ op: 'rebac.tuples', args: expr }], deny: [] }
// expr: { tuples: { relation, subjects } } | { any: expr[] } | { all: expr[] }
```

A leaf holds when the row has a tuple `#relation` whose subject key is in `subjects`. Unions become `any`, intersections `all`; empty leaves drop out, and a plan with nothing left is `abstain`.

`RebacTuplesTerm`, a `PlanTermCompiler` registered on import, renders a leaf as

```sql
EXISTS (SELECT 1 FROM authz_rebac_tuple authz_rt
        WHERE authz_rt.namespace = ? AND authz_rt.object_id = <row id as text>
          AND authz_rt.relation = ? AND authz_rt.subject_key IN (?, ...))
```

and `any`/`all` as OR/AND groups.

### Conditional tuples

A caveat reads only the request, so a list plan decides each distinct `(caveat, context)` once, before rows are read. A leaf becomes

```ts
{ tuples: { relation, subjects, conditional?: [{ caveat: caveatKey, subjects }] } }
```

`subjects` match unconditional tuples (`caveat_key IS NULL`); each group matches the tuples of one caveat key that evaluated to `allow`. `unknown` and `deny` keep nothing. A plan that evaluated a caveat has `validUntil` set to the evaluation instant, so it is never reused. The type-level residual of a permission that can reach a caveat is not cacheable and carries the values of the caveats' parameters (`caveatInput`). It lists no row granted only through a caveat that calls a condition function, or whose parameter values cannot travel in the vote: it names the caveats it decides (`decided`), any other is `unknown` at its rows; see [Conditional tuples](06-conditional-tuples.md#caching-lists-and-row-level-security).

### Row-level security

`rebac.rls` has no request to evaluate a caveat with: its SQL matches only `caveat_key IS NULL`, and `RebacRlsPlanSource` refuses a permission that reaches a conditional relation by any route (direct, subject set, arrow, union, intersection). The generator reports `AUTHZ020`, or writes a `TRUE` policy under `rls: 'partial'` (`AUTHZ021`). A conditional membership gives no session key.

### Why exclusion is not planned

A row whose proof lies past `maxDepth` is refused by the check and absent from the plan, so positive rewrites agree. Under a subtraction that breaks: a subtracted proof past the limit would vanish from the plan and list a row the check refuses. Such permissions stay on the residual path.

## Edge cases

- The subject lists grow with the groups and folders the principal reaches; very wide graphs make long IN lists.
- `RebacTuplesTerm` needs the rows' table on the same connection as `authz_rebac_tuple`.
- One OR group per distinct caveat key: per-share contexts (an expiry per share) give one group each, and a principal with very many of them can reach the database's bind-parameter limit.

## See also

- [Lists in authz-orm](../authz-orm/README.md)
- [The ReBAC model](01-rebac-model.md#limits)
