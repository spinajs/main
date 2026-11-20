---
"@spinajs/audit": patch
"@spinajs/audit-orm": patch
---

`record()` refuses an event with `kind: 'custom'` and `action: 'erasure'` with `AuditConfigError`, in every write mode, and writes nothing of a call that holds one: the pair is reserved for the record `forget` writes, which an erasure never blanks and `verify` reads as the explanation of a blanked payload. `forget` records it through its own path. `ERASURE` and `isErasureRecord` move from `@spinajs/audit-orm`'s internals to `@spinajs/audit`, and `MemoryAuditReader` uses the same predicate.
