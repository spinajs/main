# `@spinajs/audit-orm`

The database side of `@spinajs/audit`:

- `TableAuditStore`: a trail in a table (`audit_event` by default), written inside the audited transaction or on the trail's connection. Each trail owns its table: two trails of a table store that resolve to the same table on the same connection are refused with `AuditConfigError`, so a trail you add needs its own `table`.
- `AuditTrailTableMigration`: creates a trail table; the package migrates `audit_event` on the default connection. For another table or connection, extend it, override `table()` and add `@Migration(connection)`.
- `TableAuditReader`, `pruneAudit()` and `@spinajs/audit-orm/scheduler` (`AuditRetentionTask`). Retention applies per trail, to the trail's own table; a trail or connection that fails is reported after the others were pruned.
- `Model.audit()` and `row.audit()`: the `default` trail unless named; when the model's connection is not the trail's, both are read and merged by time. They apply no authorization scoping: the application decides who may call them.
- `@spinajs/audit-orm/testing`: `TestDb`, one ORM over sqlite, PGlite and the Postgres and MySQL servers that answer, for suites that write to trail tables.

## Confirmed writes inside a transaction

Whether a confirmed event survives the rollback of a transaction open on the connection it is written to depends on the driver. On a pooled driver (Postgres, MySQL, MSSQL) it is written on a connection of its own and is kept when the caller's transaction rolls back. On a driver that serves one transaction at a time (sqlite, PGlite: `supportedFeatures().concurrentTransactions` is `false`) it joins the caller's open transaction, because written apart it would wait for that transaction to end: there it is **not** kept when the transaction rolls back. So on such a driver, record the audit of a refused or failed action after the transaction that is rolled back, not inside it. The same holds for events a producer records inside the transaction, such as a read audited by `@AuditReads`: they are lost with its rollback too, so on sqlite and PGlite "no row is disclosed without a record" does not hold for reads made inside a transaction that rolls back.

A joined write is tried once, without the trail's retries and without a deadline, inside a savepoint; joined writes of one transaction run one after another. When one fails, the caller's transaction stays usable, a `reject` trail throws `AuditWriteFailed` for the caller to decide, and a `continue` trail logs the loss. The caller must await `record` inside its transaction: a joined write left running may land after the transaction has ended.

A confirmed write that is not joined and cannot finish fails at `audit.confirmTimeoutMs` (default 10000 ms): `AuditWriteFailed` on a `reject` trail, a logged loss on a `continue` trail. That is the case for connections that share one PGlite instance (`Options.Shared`): they are not detected as one connection, so a confirmed write to one of them while another holds a transaction waits for it and fails at the deadline.
