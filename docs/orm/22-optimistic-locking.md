# Optimistic locking

`@Version()` marks one integer column that versions the row. A write through the model matches the row only while it still holds the version the model was read at. When it no longer does, the statement changes no row and the write throws `OptimisticLockError`; inside `save()` the whole graph rolls back.

```ts
@Model('invoice')
export class Invoice extends ModelBase {
  @Primary()
  public Id: number;

  public Total: number;

  @Version()
  public Revision: number;
}
```

Declare the column `NOT NULL` in the migration: `table.int('Revision').notNull()`. A `bigint` column works too: a version that arrives as a string of digits (pg returns `bigint` that way) is read as a number; any other string counts as no version and the write is refused.

| Path | Versioned |
|---|---|
| `insert()`, `Model.create()`, `save()` of a new model | Sets the column to 1. A failed `insert()` puts the previous value back |
| static `Model.insert(data \| data[])` (seeds, fixtures) | A model starts at 1; a plain object keeps a version it supplies and starts at 1 otherwise |
| `update()`, `save()` of a loaded model, `archive()` | `SET Revision = old + 1 … WHERE Revision = old`, then the model holds the new version |
| `destroy()` | `WHERE Revision = old`; a `@SoftDelete` destroy also sets `Revision = old + 1` |
| `save({ reload: true })` | The model keeps the version it was read at, so a stale model is still refused; a row that is gone throws instead of being inserted again |
| bulk `Model.update(…)` | `SET Revision = Revision + 1` on every row it matches, so copies read before it are refused |
| bulk `Model.destroy(…)` builders, raw SQL | No: a bulk statement has no "old version" |
| `save()` orphan deletes (`OrphanPolicy.Delete`) | No: they delete by key |
| upserts (`InsertBehaviour.InsertOrUpdate`) | An existing row keeps its version; the model holds 1 afterwards, so reload it before you update it |
| `InsertBehaviour.InsertOrReplace` | Refused with `InvalidOperation`: a replace would restart the version of an existing row |

A model that `save()` inserts with a deferred self-referencing foreign key (a cycle in the graph) is written by an INSERT and a follow-up UPDATE, so it ends at version 2.

`save()` runs in one transaction, so a stale row anywhere in the graph rolls back the whole graph. The models of that graph get back the versions and change baselines they had before the call, so an edit to a row that was written and then rolled back is still pending: refresh the stale row and call `save()` again.

The static insert writes the version and generated keys back onto the objects you pass.

`OptimisticLockError` carries `model`, `key` and `expectedVersion`, and extends `ConcurrencyConflict` from `@spinajs/exceptions`. `@spinajs/http` answers it with 409 `application/problem+json`, with those three fields as extension members.

A REST client sends back the version it read. Hydrate it onto the loaded model (`model.hydrate(body)`) before `update()`, and a stale edit then answers 409 instead of overwriting.
