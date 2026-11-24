---
"@spinajs/orm-sqlite": minor
---

`SqliteServerResponseMapper` overrides `insertedKeys(response, insert)` with SQLite's own rule, so the keys `ModelBase.insert()`, the static `Model.insert()`, the unit of work and the write capture take for inserted rows no longer depend on the core `LastInsertId` rule. The keys of the `RETURNING` rows come first; every model insert of an `auto` key and every upsert has them. An insert without them gets `lastID` as its key only for one row written into a rowid table through its `INTEGER PRIMARY KEY`, when the statement inserted that row (`changes` is 1) and `lastID` is a positive safe integer.

Every other insert has no known key: several rows, an upsert without its `RETURNING` rows, a key that is not the rowid alias, an insert without a model, and a row a `WITHOUT ROWID` table keys itself (a supplied key `lastID` does not hold, or a key the column default fills). Before, an `INSERT OR IGNORE` built without `ModelBase.insert` that skipped its row reported the row of an earlier insert on the connection, which the write capture then handed to observers as inserted; it now reaches them with `unknownKeys: true`, as does an insert into a `WITHOUT ROWID` table whose key the column default fills.
