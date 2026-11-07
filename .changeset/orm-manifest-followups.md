---
"@spinajs/orm": patch
"@spinajs/manifest": patch
"@spinajs/orm-sqlite": patch
"@spinajs/orm-mssql": patch
---

`db.Models.Source = 'manifest'` follow-ups: `reloadTableInfo({ models })` warns only the drift of the models it read, so `migrate()` no longer repeats every recorded drift. A model whose class and table name more than one manifest model has is warned about and keeps the `tableInfo()` merge, instead of taking the first entry.

`SqlDialectProfile` gains `uniquePrimaryKey` and `rowidType`: the manifest source flags a primary key column `Unique` only where the driver's `tableInfo()` does (sqlite: a single-column key that is not the `INTEGER` rowid; mssql: never), so an untargeted `onDuplicate()` targets the same columns under both sources.
