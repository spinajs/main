---
"@spinajs/audit": patch
---

`audit.deferred.blockCeilingMs` is measured on a monotonic clock: a wall clock stepped back no longer prolongs a block, and one stepped forward no longer lifts it early.
