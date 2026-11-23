---
"@spinajs/orm": patch
"@spinajs/orm-sqlite": patch
---

A foreign key taken from a relation passes the foreign-key column's converter when it is written, as an assigned column value does: the `@BelongsTo` key of `toSql()` (from the related model, from the raw column, or of a recursive relation), a model held under a `@BelongsTo` property of a plain-object `insert()`, the junction rows `save()` inserts and the child keys `save()` resolves after inserting the parent. A many-to-many `sync()` no longer loses the link of a new member whose junction foreign key has a converter (`@Uuid()`), and `where()` / `populate()` find a child whose key was set through its relation. `NULL` and foreign keys without a converter are written as before.

Rows written before keep the unconverted value; see "Foreign keys taken from a relation pass the column converter" in `docs/orm/04-converters-and-hydration.md`.

`ModelToSqlConverter` has a protected `relationForeignKeys(model)` that both `StandardModelToSqlConverter` and `SqliteModelToSqlConverter` use for the relation-managed foreign keys; a custom subclass that overrides `toSql()` calls it.
