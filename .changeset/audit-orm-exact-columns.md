---
"@spinajs/audit-orm": patch
---

Every text column of the trail, buffer, archive and seal tables (`AuditTrailTableMigration`, `auditEventColumns`, `AuditOutboxTableMigration`, `AuditArchiveTableMigration`, `AuditSealTableMigration`), the payload `data` included, is declared `exact()`: `utf8mb4` with `utf8mb4_bin` on MySQL, `COLLATE "C"` on Postgres, `NVARCHAR` with `Latin1_General_100_BIN2` on MSSQL. A subject, actor or payload is stored as given on a database whose default is `latin1` or a case-insensitive collation, and `forget({ type: 'user', id: 'abc' })` no longer erases the events of `ABC` there.
