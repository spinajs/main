---
'@spinajs/authz': patch
---

A `ctx.check()` answer a model memoises in `ctx.cache` now keeps what it rested on. A decision that reads it gets the nested decisions' tags and their earliest `validUntil`, as if it had made the check, and is cached no longer. The memoised value is not served after that `validUntil`: the check runs again. Before, a decision that read such a memo was cached for the full `authz.cache.ttlSeconds` and missed the nested grant's revocation, so access stayed allowed after the grant ended. Values that no nested check produced are unchanged, and so is the `ctx.cache` API.
