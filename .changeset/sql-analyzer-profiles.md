---
'@spinajs/compiler': minor
'@spinajs/eslint-plugin-orm': minor
---

`analyzeSql`, `spinajs doctor` and the `typed-sql` rule type raw rows from the dialect profile of the connection's driver: pg `COUNT`/`SUM`/`AVG` are strings, mysql and sqlite comparisons are numbers. `SqlDialect`, `SQL_DIALECTS`, `isSqlDialect` and `dialectOfDriver` are removed; use `resolveSqlDialect`.
