# `@spinajs/audit`

The audit trail of a SpinaJS application: who did what to what, with which outcome, in which request.

- `audit().record(input, options)`: one event shape for data changes, reads, actions, security events and the application's own events.
- Trails (`audit.trails`): named destinations with their own store, failure mode, retries, masking and retention.
- Ports: `AuditStore`, `AuditReader`, `AuditEventSink`, `AuditContext`. `LogAuditStore` ships here; the table store is `@spinajs/audit-orm`.
- `canonicalJson`, `payloadHash`: how the `data_hash` of an event is computed, wherever a copy of it is stored.
- `@spinajs/audit/testing`: an in-memory store and reader and a settable context for tests.

This package depends on neither the ORM nor http.
