---
"@spinajs/orm": minor
"@spinajs/orm-sql": minor
"@spinajs/orm-sqlite": minor
"@spinajs/orm-mysql": minor
"@spinajs/orm-postgres": minor
"@spinajs/orm-mssql": minor
---

`SqlExpressions` gains `epochMillis()` (the current instant in epoch milliseconds, read at statement time), `concat(...parts)` and `rowLock(mode)`. The select builder gains `forUpdate()` and `forShare()`, compiled through the driver's `rowLock`: `FOR UPDATE` / `FOR SHARE` on PostgreSQL and PGlite, `FOR UPDATE` / `LOCK IN SHARE MODE` on MySQL, nothing on SQLite (a write transaction locks the database), `NotSupported` on MSSQL.
