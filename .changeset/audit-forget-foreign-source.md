---
"@spinajs/audit-orm": patch
---

In a receiving service, `forget(subject, source)` on a shipping trail with the name of a shipping application's connection no longer throws `AuditConfigError` (`no ORM connection`): a `source` that is no connection here skips the local buffer, redacts the destination's events of that source, and records the `erasure` event on the trail's connection, where the queue consumer looks for pending erasures. An application that holds `audit_outbox` on any connection logs a warning on `audit-ship` naming that `source`, in case it is a mistyped connection.
