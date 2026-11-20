---
"@spinajs/audit-orm": minor
---

`ArchiveAuditSink` stores a shipped trail in the trail's table on the connection named by `audit.trails.<name>.archiveConnection`, once per event `id`, also when two deliveries of one batch run at once; `ArchiveAuditReader` reads, redacts and prunes it there, filtered by the `source` connection. Declare `AuditArchiveTableMigration` on the archive connection. Reads of a shipping trail see an event after it was shipped. An archive table belongs to its trail: an archive on the table of a table trail, or two archives in one table on one connection, refuse the later trail with `AuditConfigError`. `forget` without a `source` redacts the subject in the archive for every source; a trail whose table or archive is `audit_outbox` is refused; a delivery that fails after its retries says so instead of pointing at the migration, which it names only when the archive table is missing.
