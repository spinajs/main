---
"@spinajs/audit-orm": patch
---

`TableAuditStore` implements `joinsCaller`: a confirmed write made while a transaction is open on its connection, on a driver that serves one transaction at a time (`supportedFeatures().concurrentTransactions` false: sqlite, PGlite), is written inside that transaction instead of waiting for it to end until `audit.confirmTimeoutMs`. There it commits and rolls back with the caller's transaction; it is tried once, without a deadline, under a savepoint, so a failed insert leaves the caller's transaction usable. On pooled drivers (Postgres, MySQL, MSSQL) a confirmed write stays detached and is kept when the caller's transaction rolls back.
