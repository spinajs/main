---
"@spinajs/audit": minor
"@spinajs/audit-orm": patch
---

`forget(subject)` without a `source` on a table trail now erases the subject on every connection that holds the trail table (with the columns `seq`, `at` and `data_hash`), not only on the trail's own connection, where transactional events of other connections stayed unerased. It records an `erasure` event on the trail's connection and on each other connection where it blanked something, with that connection's count, so `verify` finds the record beside the payloads it explains. Every connection is looked at before anything is blanked; then each connection's erasure is recorded right after it was blanked, so a failure on one connection never leaves an earlier one blanked without its record. `AuditReader.redactEach(trail, subject, source?)` is new: an async generator that yields one `AuditRedaction` (`{ connection, redacted }`) per connection that needs its own record, which `forget` records before it asks for the next; by default it calls `redact` once and records on `source`. `forget` returns the sum.
