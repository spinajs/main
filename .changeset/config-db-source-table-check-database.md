---
"@spinajs/configuration-db-source": patch
---

The bootstrapper's check for the `configuration` table now asks `tableInfo(table, Options.Database)` on `DbConfig`'s connection, the call the Orm makes to reflect the model and the database its queries use, instead of an unqualified `schema().tableExists(table)`. On SQLite with `Database` naming an attached database, a table only in that database was reported missing, so exposed options were silently never persisted or watched; a table only in `main` was reported present and the sweep failed on the attached database. On SQLite without `Database` the check reads `main` as before. On PostgreSQL it reads `Options.Schema` (default `public`) instead of `current_schema()`, and on MSSQL with `Options.Schema` set it reads that schema only, as the model reflection does.
