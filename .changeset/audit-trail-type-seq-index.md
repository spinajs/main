---
"@spinajs/audit-orm": patch
---

`AuditTrailTableMigration` also creates the index `<table>_type_seq` on `(subject_type, seq)`, and `AuditArchiveTableMigration` the index `<table>_type_seq` on `(source, subject_type, seq)`. The index bounds `since` with a subject type and the reads built on it (`since` of `auditOf(Model)` or `historyOf(Model)`, the absent path of `asOf`): they walk that type's events in `seq` order instead of every later event of a trail that many models write to. `byActor` with a subject type was already bounded by the `(actor, seq)` index (`(source, actor, seq)` on an archive); for it the new index only adds a path bounded by the type.
