---
"@spinajs/orm-mssql": minor
---

`MsSqlServerResponseMapper` overrides `insertedKeys(response, insert)` with SQL Server's own rule, so the keys `ModelBase.insert()`, the static `Model.insert()`, the unit of work and the write capture take for inserted rows no longer depend on the core `LastInsertId` rule. The `SCOPE_IDENTITY()` value is the key of a plain or `orIgnore()` insert of one row into a table whose single-column `auto` key is its `IDENTITY` column, when it is a positive safe integer and, for `orIgnore()`, the batch reports the row inserted.

Every other insert has no known key: several rows, a key that is not the identity column, a skipped `orIgnore()` row, a `bigint` identity past `Number.MAX_SAFE_INTEGER`, an insert without a model, and every upsert. After a `MERGE` that updated, `SCOPE_IDENTITY()` can return the identity an earlier statement of the same pooled session generated, in any table; before, a model upserted with `InsertOrUpdate` whose row carried no key could get that value as its key, and the write capture reported it. Such a model now keeps an empty key, and the write capture reports the upsert as `unknownKeys: true` when its row supplies no conflict value.
