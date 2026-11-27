---
'@spinajs/orm-mssql': minor
---

`forUpdate()` and `forShare()` work on SQL Server: the select is written with the table hint `WITH (UPDLOCK, ROWLOCK)` or `WITH (REPEATABLEREAD, ROWLOCK)` after the table, held until the transaction ends, where they threw `NotSupported` before. `supportsRowLocks(driver)` now answers `true` for an MSSQL connection, so the ORM write capture's key select and before read of an update or delete lock the rows they read, as on PostgreSQL and MySQL: a row the capture read can no longer leave the statement's where before it runs, which under READ COMMITTED made the capture report another transaction's change as the statement's (a delete as an update). Cost: those update locks are taken at the key select, earlier than the statement would take them.
