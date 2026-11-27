---
"@spinajs/orm": major
---

`insert().into(table, schema)` now passes `schema` to `database()` instead of making it the table alias. On MySQL it compiles to ``INSERT INTO `schema`.`table` `` and on MSSQL to `INSERT INTO [schema].[table]`; before, both servers refused the statement as a syntax error. On PostgreSQL and SQLite the row still goes, without an error, to the same-named table of the connection's default schema, as it did before: PostgreSQL leaves every table unqualified, and the SQLite insert compiler ignores `database()`. On PostgreSQL the second argument no longer sets an alias, so an upsert that read it, such as `into('t', 'x')` with `update([RawQuery.create('a = x.a + 1')])`, now fails with "missing FROM-clause entry for table x"; write `into('t').setAlias('x')` instead. `into(table)` with one argument compiles as before.

The schema argument has no effect on SQLite and PostgreSQL yet. Two follow-ups are open: `v4-ox-20-orm-sqlite-insert-honours-database` makes the SQLite insert qualify the table, and `v4-ox-21-orm-postgres-schema-argument` waits on an owner decision for PostgreSQL: refuse the argument, qualify the table, or keep ignoring it.
