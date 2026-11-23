---
"@spinajs/audit-orm": patch
---

`AuditTrailTableMigration` also creates the index `<table>_type_seq` on `(subject_type, seq)`, and `AuditArchiveTableMigration` the index `<table>_type_seq` on `(source, subject_type, seq)`. A feed of one subject type (`since` of `auditOf(Model)` or `historyOf(Model)`, `byActor` with a subject type, the absent path of `asOf`) walks that type's events in `seq` order instead of every later event of a trail that many models write to.
