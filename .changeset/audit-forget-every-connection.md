---
"@spinajs/audit": minor
"@spinajs/audit-orm": patch
---

`forget(subject)` without a `source` on a table trail now erases the subject on every connection that holds the trail table (with the columns `seq`, `at` and `data_hash`), not only on the trail's own connection, where transactional events of other connections stayed unerased. It records an `erasure` event on the trail's connection and on each other connection where it blanked something, with that connection's count, so `verify` finds the record beside the payloads it explains. Every connection is looked at before anything is blanked. `AuditReader.redactEach(trail, subject, source?)` is new: it returns one `AuditRedaction` (`{ connection, redacted }`) per connection that needs its own record; by default it calls `redact` once and records on `source`. `forget` returns the sum.
