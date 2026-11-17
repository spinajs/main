# `@spinajs/audit-orm`

The database side of `@spinajs/audit`:

- `TableAuditStore`: a trail in a table (`audit_event` by default), written inside the audited transaction or on the trail's connection.
- `AuditTrailTableMigration`: creates a trail table; the package migrates `audit_event` on the default connection. For another table or connection, extend it, override `table()` and add `@Migration(connection)`.
- `TableAuditReader`, `pruneAudit()` and `@spinajs/audit-orm/scheduler` (`AuditRetentionTask`).
- `Model.audit()` and `row.audit()`.
- `@spinajs/audit-orm/testing`: `TestDb`, one ORM over sqlite, PGlite and the Postgres and MySQL servers that answer, for suites that write to trail tables.

## Confirmed writes inside a transaction

Whether a confirmed event survives the rollback of a transaction open on the connection it is written to depends on the driver. On a pooled driver (Postgres, MySQL, MSSQL) it is written on a connection of its own and is kept when the caller's transaction rolls back. On a driver that serves one transaction at a time (sqlite, PGlite: `supportedFeatures().concurrentTransactions` is `false`) it joins the caller's open transaction, because written apart it would wait for that transaction to end: there it is **not** kept when the transaction rolls back. So on such a driver, record the audit of a refused or failed action after the transaction that is rolled back, not inside it. A joined write is tried once, without the trail's retries and without a deadline, inside a savepoint: when it fails, the caller's transaction stays usable, a `reject` trail throws `AuditWriteFailed` for the caller to decide, and a `continue` trail logs the loss. A confirmed write that is not joined and cannot finish (a driver that blocks it some other way) fails at `audit.confirmTimeoutMs` (default 10000 ms): `AuditWriteFailed` on a `reject` trail, a logged loss on a `continue` trail.
