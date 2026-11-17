---
"@spinajs/orm": minor
"@spinajs/orm-sqlite": patch
"@spinajs/orm-postgres": patch
"@spinajs/orm-mysql": patch
---

`LiveIndex.inexact`: `tableIndexes()` marks an index with an expression part or (MySQL) a column prefix part. The write capture reports an upsert that may conflict through such an index as `unknownKeys` instead of missing the row it changed, keeps a table's index list until the ORM reloads the table, and on PostgreSQL and SQLite reads an `onDuplicate(column)` upsert by that column alone.
