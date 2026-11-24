---
"@spinajs/orm": patch
---

A primary key the database generates (generation `auto`) that has no value on the model is left out of the row `toSql()` builds, so the column default applies. A `@Primary() @Uuid()` key on a column with a default (`bytea DEFAULT uuid_send(gen_random_uuid())` on PostgreSQL) failed every `insert()`, `Model.insert()` and `save()` with `InvalidArgument: value column Id cannot be null`, because `UuidConverter` wrote `NULL` over the default. A key with a value, a `uuid` or `assigned` key and every other column are written as before.
