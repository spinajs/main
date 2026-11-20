---
'@spinajs/orm-mssql': minor
---

`orIgnore()` and `InsertBehaviour.InsertOrIgnore` work on SQL Server: the insert runs in a `TRY…CATCH` batch that leaves a duplicate key (errors 2627, 2601) as a no-op and reports `RowsAffected: 0`. One row per statement; several rows throw at compile time. Before, both threw `mssql insert or ignore is not supported`. `queue.outbox` and the ORM store of `@spinajs/idempotency` insert this way, so both get past their insert on SQL Server now; neither is run on SQL Server by a CI job.
