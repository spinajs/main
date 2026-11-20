---
"@spinajs/audit": patch
---

The `AuditStore.append` and `joinsCaller` docs say what the service does around an append: a detached confirmed or deferred write is retried and handled by `onFailure`, a transactional or joined write is tried once, and a store that joins the caller must bound its append itself.
