---
"@spinajs/orm": patch
---

The write capture's before and after reads now qualify the table with the `Database` of the model's connection, as every model query does. Before, they read the bare table name: on SQLite with `Database` naming an attached database and a table of the same name in `main`, a `WriteObserver` (and so `@spinajs/orm-history`) got the rows of `main` or no rows at all for a model insert, update or delete, without an error. On MySQL and MSSQL the reads now address `` `<Database>`.`table` `` like the key select and the write itself; PostgreSQL leaves every table unqualified, so its SQL is unchanged. A connection without `Database` produces the same SQL as before.
