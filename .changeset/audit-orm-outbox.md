---
"@spinajs/audit-orm": minor
---

`OutboxAuditStore` records the events of a trail in `audit_outbox`, inside the audited write's transaction when there is one; `shipAudit()` and `AuditShipTask` deliver them to the trail's `AuditEventSink`, at least once, each event with its stable `id`; `auditBacklog()` reports what is pending per trail and connection. Declare `AuditOutboxTableMigration` on every connection that buffers.
