# `@spinajs/audit-orm`

The database side of `@spinajs/audit`:

- `TableAuditStore`: a trail in a table (`audit_event` by default), written inside the audited transaction or on the trail's connection.
- `AuditTrailTableMigration`: creates a trail table; the package migrates `audit_event` on the default connection. For another table or connection, extend it, override `table()` and add `@Migration(connection)`.
- `TableAuditReader`, `pruneAudit()` and `@spinajs/audit-orm/scheduler` (`AuditRetentionTask`).
- `Model.audit()` and `row.audit()`.
- `@spinajs/audit-orm/testing`: `TestDb`, one ORM over sqlite, PGlite and the Postgres and MySQL servers that answer, for suites that write to trail tables.
