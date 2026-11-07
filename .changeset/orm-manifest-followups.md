---
"@spinajs/orm": patch
"@spinajs/manifest": patch
"@spinajs/orm-sqlite": patch
"@spinajs/orm-mssql": patch
"@spinajs/orm-mysql": patch
"@spinajs/orm-postgres": patch
"@spinajs/orm-pglite": patch
"@spinajs/orm-cli": patch
"@spinajs/compiler": patch
---

`db.Models.Source = 'manifest'` follow-ups: `reloadTableInfo({ models })` warns only the drift of the models it read, so `migrate()` no longer repeats every recorded drift. A model whose class and table name more than one manifest model has is warned about and keeps the `tableInfo()` merge, instead of taking the first entry. The boot's `nullability` warning skips the columns every new instance gets a value for (`@Uuid`, `@CreatedAt`).

`SqlDialectProfile` gains `uniquePrimaryKey` and `rowidType`: the manifest source flags a primary key column `Unique` only where the driver's `tableInfo()` does (sqlite: a single-column key that is not the `INTEGER` rowid; mssql: never), so an untargeted `onDuplicate()` targets the same columns under both sources.

`@spinajs/orm-sqlite`, `@spinajs/orm-mysql`, `@spinajs/orm-postgres`, `@spinajs/orm-pglite` and `@spinajs/orm-mssql`: the dialect profiles count a sqlite `TEXT`, a mysql `CHAR`/`VARCHAR`, a postgres `varchar`/`bpchar` and an mssql `varchar`/`nvarchar`/`char` column as able to hold a `uuid` (packages store uuids as `string(name, 36)`), so `migrate-diff` and the drift check no longer report a type change for one.

`@spinajs/orm-cli`: `migrate-diff --package <names>` and `--exclude-package <names>` choose the packages whose models count (the app's own always do under `--package`), for the base manifest too, so the tables of packages the app does not use are left out.

`@spinajs/compiler`: a model column with `@UpdatedAt`, `@SoftDelete` or `@Archived` is recorded `nullable` in the manifest whatever its TypeScript type, since the ORM leaves it empty until an update, a soft delete or an archive. Under `db.Models.Source = 'manifest'` an insert no longer fails `Field … cannot be null` on such a column.
