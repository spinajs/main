---
"@spinajs/orm-mssql": minor
---

The key of a row a model inserts or upserts comes from `OUTPUT inserted.<key columns>`, so these now report their key to `ModelBase.insert()`, the static `Model.insert()`, the unit of work and the write capture:

- a one-row insert whose key the database generates in any way: an `IDENTITY` column, a `NEWID()` / `NEWSEQUENTIALID()` default, a `NEXT VALUE FOR` sequence default; a composite key with all of its parts;
- an upsert (`MERGE`, `InsertBehaviour.InsertOrUpdate`): the key of the row it inserted or updated;
- a table with triggers, a table whose trigger returns a result set, a memory-optimized table, and a view without an `INSTEAD OF` trigger.

Still no key: several rows (SQL Server does not promise `OUTPUT` rows in `VALUES` order), a skipped `orIgnore()` row, a table or view with an `INSTEAD OF` trigger, a `bigint` or `decimal` key past `Number.MAX_SAFE_INTEGER` unless the key is `@Int64('string')` or `@Int64('bigint')`, and a key of another type than an integer, decimal, `uniqueidentifier` or character type. A login that cannot see the table's metadata (`DENY VIEW DEFINITION`), an insert through a synonym, and a login without `SELECT` on the key get the key of an `IDENTITY` column only, as before. A key column with a converter gets the value through its `fromDB()`; a `bigint` key without one is a number, as before.

The compiled SQL of a one-row model insert and of a model upsert changes. The batch holds the statement twice, with `OUTPUT ... INTO` a `sql_variant` table variable for a login with `SELECT` on the key columns (`HAS_PERMS_BY_NAME`) and without it otherwise, its values bound once (the second form is written with the driver's `@p<n>` parameter names); it selects the keys, then its own row `SELECT @spinajs_identity as ID, @spinajs_inserted as INSERTED, <1 when the keys are exact> as KEYS_EXACT`. The insert result gains `InsertedKeys`. A model upsert now resolves with the insert result object (`RowsAffected` is the `MERGE`'s own count) instead of the `[{ ID }]` rows; an upsert without a model is unchanged. `LastInsertId` is read from the batch's own row, also on a table whose trigger returns a result set.
