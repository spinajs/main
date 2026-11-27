---
"@spinajs/orm": major
---

`insert().into(table, schema)` now passes `schema` to `database()` instead of making it the table alias. On MySQL it compiles to ``INSERT INTO `schema`.`table` `` and on MSSQL to `INSERT INTO [schema].[table]`; before, both servers refused the statement as a syntax error. On SQLite it compiles to ``INSERT INTO `schema`.`table` `` and writes into the attached database `schema` (see the `@spinajs/orm-sqlite` entry). On PostgreSQL the row still goes, without an error, to the same-named table of the connection's `search_path`, as it did before: PostgreSQL leaves every table unqualified. On PostgreSQL the second argument no longer sets an alias, so an upsert that read it, such as `into('t', 'x')` with `update([RawQuery.create('a = x.a + 1')])`, now fails with "missing FROM-clause entry for table x"; write `into('t').setAlias('x')` instead. `into(table)` with one argument compiles as before.

The schema argument has no effect on PostgreSQL yet: `v4-ox-21-orm-postgres-schema-argument` waits on an owner decision: refuse the argument, qualify the table, or keep ignoring it.
