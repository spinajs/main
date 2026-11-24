---
"@spinajs/orm": major
"@spinajs/orm-mysql": patch
"@spinajs/orm-mssql": patch
"@spinajs/orm-sqlite": patch
"@spinajs/orm-postgres": patch
---

Breaking for a connection package without `RETURNING` that does not override `ServerResponseMapper.insertedKeys()`: the default now reports only the keys in the `RETURNING` rows and never reads `LastInsertId`. Such a connection's inserts no longer backfill keys: `ModelBase.insert()` and the static `Model.insert()` leave an `auto` key empty, a unit-of-work `save()` throws `OrmException` (`insert of <Model#key> returned no generated key ...`), and write observers get the insert with `unknownKeys: true`. Override `insertedKeys(response, insert)` in the connection's mapper with the dialect's own rule; the protected `returnedKeys()` gives the `RETURNING` keys to fall back from. See "Keys of inserted rows without RETURNING" in the dialect guide of `@spinajs/orm-sql`.

`ISupportedFeature.insertIdIsFirstOfBatch` is removed; nothing reads it. A `supportedFeatures(): ISupportedFeature` that still returns it in an object literal no longer compiles; drop the field. The MySQL, MSSQL, SQLite and PostgreSQL drivers no longer declare it, and their keys of inserted rows are unchanged: each reports them by its own rule.
