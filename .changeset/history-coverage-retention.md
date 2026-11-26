---
"@spinajs/audit-orm": minor
"@spinajs/orm-history": minor
---

A retention run tells every registered `AuditRetentionListener` the trail, the connection and the cutoff (`beforePrune`) before it deletes the events of that connection; a listener that rejects keeps those events and the run reports the connection in `AuditPruneFailed`. `@spinajs/orm-history` registers one: the coverage of a trail moves up to the cutoff before its older events are deleted, and when it cannot be moved nothing is deleted on that connection. `HistoryCoverage.since()` of a trail with `retentionDays` never answers earlier than that many days before the call, so a retention run by a process that never imported `@spinajs/orm-history` cannot leave a coverage over events it deleted; still run retention where the package is loaded, because that bound does not help after `retentionDays` was raised or removed, nor after a reader's `prune` called directly.
