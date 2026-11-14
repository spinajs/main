---
"@spinajs/orm": minor
"@spinajs/orm-sql": minor
"@spinajs/durable": patch
---

`OrmDriver.epochMillis()` returns the database's current instant in epoch milliseconds, read when the statement runs rather than when its transaction began, and runs inside the transaction in scope. Every SQL driver (SQLite, PGlite, PostgreSQL, MySQL, MSSQL) inherits it from `SqlDriver`, built from its `SqlExpressions.epochMillis()`; the base driver throws `NotSupported`. `SqlDbTimeSource` in `@spinajs/durable` now reads the database time through it and no longer writes SQL of its own.
