---
"@spinajs/audit-orm": minor
---

`OutboxAuditStore` records the events of a trail in `audit_outbox`, inside the audited write's transaction when there is one; `shipAudit()` and `AuditShipTask` deliver them to the trail's `AuditEventSink`, at least once, each event with its stable `id`; `auditBacklog()` reports what is pending per trail and connection. Declare `AuditOutboxTableMigration` on every connection that buffers. A delivery has a deadline (`audit.ship.deliverTimeoutMs`, default 30000); a connection that cannot be searched is reported, not fatal; an erasure blanks the buffer on every connection that buffers, and an event erased before its delivery returned is redacted at the destination through the trail's reader before its buffer row is removed, also when an abandoned delivery lands late. On sqlite and PGlite a confirmed write to an outbox trail joins the caller's open transaction, as on a table trail.
