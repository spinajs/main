---
"@spinajs/orm": patch
---

`insert().into(table, schema)` now qualifies the table with `schema`, as `database(schema)` does: on MySQL it compiles to ``INSERT INTO `schema`.`table` `` and on MSSQL to `INSERT INTO [schema].[table]`. Before, the second argument became a table alias: MySQL and MSSQL refused the statement as a syntax error, and PostgreSQL and SQLite wrote the row into the same-named table of the connection's default schema. `into(table)` with one argument compiles as before.
