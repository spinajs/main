# Optimistic locking

`@Version()` marks one integer column that versions the row. A write through the model succeeds only when the row still holds the version the model was read at. Otherwise it throws `OptimisticLockError` and writes nothing.

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

Declare the column `NOT NULL` in the migration: `table.int('Revision').notNull()`.

| Path | Versioned |
|---|---|
| `insert()`, `Model.create()`, `save()` of a new model | Sets the column to 1 |
| static `Model.insert(data \| data[])` (seeds, fixtures), with models or plain objects | Sets the column to 1 on every row |
| `update()`, `save()` of a loaded model | `SET Revision = old + 1 … WHERE Revision = old`, then the model holds the new version |
| `destroy()` (hard or `@SoftDelete`) | `WHERE Revision = old` |
| bulk `Model.update(…)`, `Model.destroy(…)` builders, raw SQL | No: a bulk statement has no "old version" |
| `save()` orphan deletes (`OrphanPolicy.Delete`) | No: they delete by key |
| `archive()`, upserts (`InsertBehaviour.InsertOrUpdate`) | No; an upsert leaves an existing row's version alone |

`save()` runs in one transaction, so a stale row anywhere in the graph rolls back the whole graph. The models of that graph may already carry the versions of writes that were rolled back, so reload them before you retry.

`OptimisticLockError` carries `model`, `key` and `expectedVersion`, and extends `ConcurrencyConflict` from `@spinajs/exceptions`. `@spinajs/http` answers it with 409 `application/problem+json`, with those three fields as extension members.

A REST client sends back the version it read. Hydrate it onto the loaded model (`model.hydrate(body)`) before `update()`, and a stale edit then answers 409 instead of overwriting.
