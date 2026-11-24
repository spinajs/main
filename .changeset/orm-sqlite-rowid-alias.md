---
"@spinajs/orm-sqlite": minor
---

`tableInfo()` flags a column `AutoIncrement` only when it is the rowid alias: the lone primary key column of a table whose `PRAGMA index_list` has no index of origin `pk`. `INTEGER PRIMARY KEY DESC` and the `INTEGER PRIMARY KEY` of a `WITHOUT ROWID` table are no longer flagged; `PRAGMA table_info` reports them like a rowid alias, so they were.

What changes for a model on such a table:

- `INTEGER PRIMARY KEY DESC`: an insert without a key without `RETURNING` rows reports no key, where it reported the hidden rowid, which is not the key (the row stores `NULL`); write observers get `unknownKeys: true`.
- `WITHOUT ROWID`: a row whose key is `null` fails before SQLite with `InvalidArgument('value column <c> cannot be null')`, where SQLite raised a NOT NULL constraint error, or, for a key column with a `DEFAULT`, filled the default. Leave the key out to get the default. The model's request schema requires the key, and `getOrNew()` keeps a key the caller passes instead of dropping it.
