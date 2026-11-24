---
"@spinajs/orm": patch
"@spinajs/orm-sqlite": patch
---

A foreign key taken from a relation passes the foreign-key column's converter when it is written, as an assigned column value does: the `@BelongsTo` key of `toSql()` (from the related model, from the raw column, or of a recursive relation), a model held under a `@BelongsTo` property of a plain-object `insert()`, the junction rows `save()` inserts and the child keys `save()` resolves after inserting the parent. A many-to-many `sync()` no longer loses the link of a new member whose junction foreign key has a converter (`@Uuid()`), and `where()` / `populate()` find a child whose key was set through its relation. `NULL` and foreign keys without a converter are written as before.

`UuidConverter.toDB()` returns a 16-byte `Buffer` or `Uint8Array` as it is, so a `@Uuid()` foreign key whose value is already in database form (copied from a raw row, or the key of a parent whose database-generated key `save()` read back through `RETURNING`) is written unchanged instead of throwing `TypeError`. A byte value of another length throws `InvalidArgument`.

Rows written before keep the unconverted value. Repair them before the first `sync()`, `update()` or `save()` of such a relation: without the repair, the first `sync()` of an owner deletes every junction row of that owner still in the unconverted form, including the rows of the members it keeps, and does not write them again. See "Foreign keys taken from a relation pass the column converter" in `docs/orm/04-converters-and-hydration.md` for the SQLite statement and the limits on other converters and on MySQL.

`ModelToSqlConverter` has a protected `relationForeignKeys(model)` that both `StandardModelToSqlConverter` and `SqliteModelToSqlConverter` use for the relation-managed foreign keys; a custom subclass that overrides `toSql()` calls it.
