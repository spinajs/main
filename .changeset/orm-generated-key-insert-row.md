---
"@spinajs/orm": patch
---

A primary key the database generates (generation `auto`) that has no value on the model is left out of the row `toSql()` builds, so the column default applies. A `@Primary() @Uuid()` key on a column with a default (`bytea DEFAULT uuid_send(gen_random_uuid())` on PostgreSQL) failed every `insert()`, `Model.insert()` and `save()` with `InvalidArgument: value column Id cannot be null`, because `UuidConverter` wrote `NULL` over the default. A key with a value, a `uuid` or `assigned` key and every other column are written as before.

The failure of a forgotten key moves: an `auto` key without a value on a column that has no default and is not auto-increment used to fail before the statement, on every connection but SQLite, with `InvalidArgument: value column <name> cannot be null`; it now fails in the database with `ConstraintViolation` (kind `not_null`). On PostgreSQL the failed statement aborts the caller's transaction, and MySQL without a strict `sql_mode` writes the column's implicit default instead of failing.
