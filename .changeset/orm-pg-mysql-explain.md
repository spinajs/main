---
"@spinajs/orm-postgres": minor
"@spinajs/orm-mysql": minor
---

`PostgresOrmDriver.explain()` (`EXPLAIN (FORMAT JSON)`) and `MySqlOrmDriver.explain()` (`EXPLAIN FORMAT=JSON`) return a normalised `PlanNode` tree (`normalizePostgresPlan`, `normalizeMysqlPlan`) with estimated rows and cost, so slow-query records on these databases carry plans. PGlite inherits the postgres `explain`. On postgres the bindings travel as statement parameters; on MySQL the driver writes them into the statement text, as it does for every statement. EXPLAIN runs on a pool connection of its own, never on the caller's transaction, and never with `ANALYZE`; on PGlite, which has one session, it must not be awaited inside a transaction.
