---
"@spinajs/orm-sqlite": patch
"@spinajs/orm": patch
---

The SQLite driver's `tableInfo()`, `tableIndexes()` and `tableForeignKeys()` now read the schema they are given, through `PRAGMA "<schema>".table_info(...)` and the qualified `index_list`, `index_info` and `foreign_key_list`. Before, they ignored it and read the table of `main`: on a connection whose `Database` names an attached database with a table of the same name in `main`, a model reflected the columns and `Unique` flags of `main`, so `InsertOrUpdate` targeted the wrong conflict column and failed. A schema that is not attached reads as holding no table. Without a schema the pragmas are unchanged.

The write capture reads an upsert's unique indexes in the database of the model's connection, as it reads the rows: a captured `InsertOrReplace` now includes the row it deleted, and an ignored or replacing insert no longer reports an untouched row because of an index of `main`.
