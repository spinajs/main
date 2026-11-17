---
"@spinajs/audit": minor
"@spinajs/audit-orm": minor
---

`integrity: 'sealed'`: `AuditSealTask` (every 60 seconds, leader only) and `sealAudit()` hash the events of a sealed trail in `seq` order into chained seals in `audit_seal`, per table and connection, at the archive for a shipping trail. A run seals what was already there 30 seconds earlier (`audit.seal.settleSeconds`), so an event is sealed within about two minutes; a row that commits with a lower `seq` more than one settle time after a higher one was seen lands in a sealed range unsealed, which verification reports. Each seal is read and written in a transaction of its own, so a row of a caller's open transaction is never sealed before it commits. `@spinajs/audit` exports `eventDigest` and `sealHash` next to `payloadHash`. Retention on a sealed table removes whole sealed ranges and keeps their seals, marked pruned; events not sealed yet stay. Declare `AuditSealTableMigration` on every connection that holds a sealed table; a trail may not use `audit_seal` as its table.
