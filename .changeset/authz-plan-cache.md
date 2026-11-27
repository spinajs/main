---
"@spinajs/authz": minor
---

`@spinajs/authz`: an access plan carries `cache` (`AccessPlanCache`: key, decision tags, a TTL that ends no later than the plan or any nested check it rested on) when every model that planned it answers `listPlanCacheable(permission, type)`, the call had no env, the permission is not `fresh`, no model failed and every nested check it rested on could be cached. New port `AuthzCacheTags`, which renders those tags for a cache outside authz; nothing registers it yet, so nothing is cached. A `filter` plan's `validUntil` now also ends with the nested checks its models made in `listPlan()`, so the plan memo of a long request ends with them too.
