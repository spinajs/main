---
"@spinajs/orm": minor
"@spinajs/orm-sqlite": minor
"@spinajs/orm-postgres": minor
"@spinajs/orm-mysql": minor
"@spinajs/orm-mssql": minor
---

`OrmDriver` gains two optional methods, `tableIndexes(name, schema?)` and `tableForeignKeys(name, schema?)`, returning `LiveIndex[]` (primary key included) and `LiveForeignKey[]` (one entry per column, standard action names). sqlite, PostgreSQL, MySQL and SQL Server implement them; sqlite's `tableInfo()` now reads its indexes and foreign keys through the same code, with unchanged results.

PostgreSQL `tableInfo()` now reports `MaxLength` from `character_maximum_length` for bounded character columns instead of `-1`. Model JSON schemas on postgres therefore carry `maxLength` for `varchar(n)` columns, as they already do on mssql, so orm-http validation and OpenAPI output reject strings longer than the column.
