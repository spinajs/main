---
'@spinajs/authz': patch
---

A decision that rests on a model's nested `ctx.check()` is now valid, and cached in the L1 and the L2, no longer than the nested decisions it rested on: its `validUntil` is the earliest of its own and theirs, at every depth, for allows and denials alike. Before, a nested grant that expired in 5 s left the outer allow cached for the full `authz.cache.ttlSeconds`. A nested expiry that cannot be read keeps the decisions above it out of the caches.
