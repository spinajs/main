# N+1 diagnostics (ORM101, ORM102)

While it builds a package's fragment, `@spinajs/compiler` follows query results through each function body and reports two loop patterns.

| Code | Reported when | Fix |
|---|---|---|
| `ORM101` | A relation is read inside a loop over the rows of a query that did not `populate()` it: `for (const p of await Post.all()) p.Owner.Value`. Relations never load on access, so the loop reads `undefined` (single) or `[]` (many): a correctness bug, not a slow query. Message: `relation Post.Owner is read but never populated; add .populate('Owner')` | Add `.populate('Owner')` (nested: `.populate('Owner.Company')`) to the query |
| `ORM102` | A query is awaited inside a loop body or a per-element callback (`map`, `forEach`, `filter`, `reduce`, …), `relation.populate()` and `async (x) => Model.get(x)` included: the N+1 | Load the rows once before the loop (`whereIn`, `populate`) or batch them |

Both are **errors** in a package that opts into strict columns (`interface OrmTypeRegistry { strictColumns: true }` in its program) and **warnings** elsewhere. `spinajs build` fails on errors.

## What is followed

Inside one function: `await`, local variables and aliases, array destructuring (`const [first, ...rest] = await …`), `filter`/`slice`/`sort`/`find`/`at`/`[i]`, `for…of`, `for await … of query.stream()`, `map`/`forEach`/`filter`/`reduce`/`some`/`every`/`find`/`flatMap`, and `Promise.all(xs.map(…))`. A builder kept in a variable and extended by a statement (`q.populate('Owner');`) counts. Values that arrive as parameters or from other functions are not followed, so a helper taking `posts: Post[]` is never reported.

Writes in a loop (`insert`, `update`, `destroy`, `create`, `truncate`, `transaction`) are not N+1 reads and are not reported. Reading `relation.Populated`, calling `relation.populate()`, or calling a mutator that needs no populate (`add`, `set`, `remove`, `attach`, `detach`, `union`, `intersection`, `diff`, `empty`, `clear`, `sync`) is not an `ORM101` read. Awaiting `relation.populate()` in a loop is an `ORM102`, and the reads of that relation after it in the same loop body are not `ORM101`.

## Exceptions

Put a comment directly above the statement that holds the loop:

```ts
// spinajs-orm-ignore ORM102: ids never holds more than three entries
for (const id of ids) out.push(await User.get(id));
```

The reason after the colon is required; a comment without one suppresses nothing. It is not an `eslint-disable` and does not touch lint suppressions.
