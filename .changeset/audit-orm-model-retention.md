---
"@spinajs/audit-orm": minor
"@spinajs/orm": minor
---

`ModelBase.audit(trail?)`, as a static and on a loaded row, with the `ModelAuditSource` port in `@spinajs/orm`; `@spinajs/audit-orm` implements it (`Model.audit().of(id)`, `.since(seq)`, `row.audit().entries()`). A model with its own member named `audit` must rename it. `pruneAudit()` deletes the events older than each trail's `retentionDays` on every connection that holds the trail's table, and once, for every source, for a trail with an archive (`archiveConnection`); `@spinajs/audit-orm/scheduler` adds `AuditRetentionTask` (`audit.retention`, daily, leader only). A trail or connection that fails does not stop the others: they are pruned, then `AuditPruneFailed` names the failures, and the task records `{ deleted, failed }` before it fails the run. Each trail owns its table: two trails of a table store on one table and connection are refused with `AuditConfigError` on write, read and retention.
