---
"@spinajs/audit": patch
---

Deferred writes: a batch that misses `audit.deferred.timeoutMs` is given up and never retried, and the next append to the same trail and connection waits for one still under way, so a call split at `maxBatch` keeps its order. A failing logger or background flush no longer rejects a write or the process; the buffer-full warning is logged once per overflow, and a deferred `record` after dispose is written at once. An `AuditConfigError` raised by a store is never retried: confirmed writes rethrow it whatever `onFailure` says, deferred ones log it as a misconfiguration. `record` refuses `data` that cannot be written as JSON with `AuditConfigError`, `LogAuditStore` writes `data` as canonical JSON, and `canonicalJson` orders members as RFC 8785 does (by UTF-16 code units, integer-like keys included). `MemoryAuditStore.appends()` returns a copy.
