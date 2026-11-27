---
"@spinajs/orm-sqlite": major
---

On SQLite an insert now writes into the database it names: `insert().into('t').database('s')`, `insert().into('t', 's')` and a model insert on a connection that sets `Database` compile to ``INSERT INTO `s`.`t` `` and write into the attached database `s`, where select, update and delete already read and wrote; before, the row went to `main.t` without an error. A connection whose `Database` is neither `main` nor an attached database now fails its model inserts with "no such table: <Database>.<table>", as its model selects already did. The insert table goes through `TableAliasCompiler` like the other statements, so a table name with a backtick is escaped and an alias set with `setAlias()` is rendered (``INSERT INTO `t` as `x` ``), where before it was dropped. An insert without a database and without an alias compiles as before. This replaces the SQLite half of the `@spinajs/orm` entry for `into(table, schema)`.
