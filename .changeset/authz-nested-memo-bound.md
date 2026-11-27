---
'@spinajs/authz': patch
---

A `ctx.check()` answer a model memoises in `ctx.cache` now keeps what it rested on. A decision that reads it gets the nested decisions' tags and their earliest `validUntil`, as if it had made the check, and is cached no longer; a kept access plan that read it is bounded the same way. The memoised value is not served after that `validUntil`: the check runs again. An answer put inside a value stored under another key is not bounded (see "Writing a model"). Before, a decision that read such a memo was cached for the full `authz.cache.ttlSeconds` and missed the nested grant's revocation, so access stayed allowed after the grant ended. Each value rests on every nested check of the decision that stored it, those of its other models included; values stored by a decision that made no nested check are unchanged. The `ctx.cache` type is unchanged; two decisions of one request now see the same entries through different `Map` objects.
