---
"@spinajs/audit": patch
---

Deferred writes: a batch that misses `audit.deferred.timeoutMs` is given up and never retried, and the next append to the same trail and connection waits for one still under way, so a call split at `maxBatch` keeps its order. An append that does not settle by the next batch's deadline blocks its trail and connection: their deferred batches are dropped unsent and logged as lost (with one warning per blocked target) until it settles, which is logged too. A failing logger or background flush no longer rejects a write or the process; the buffer-full warning is logged once per overflow, and a deferred `record` after dispose is written at once. An `AuditConfigError` raised by a store is never retried: confirmed writes rethrow it whatever `onFailure` says, deferred ones log it as a misconfiguration. `record` refuses `data` that cannot be written as JSON with `AuditConfigError`, `LogAuditStore` writes `data` as canonical JSON, and `canonicalJson` orders members as RFC 8785 does (by UTF-16 code units, integer-like keys included). `MemoryAuditStore.appends()` returns a copy.

An unknown key on a trail or in its `retry` (a misspelt `onFailure`, say) now fails the boot instead of being dropped silently.
