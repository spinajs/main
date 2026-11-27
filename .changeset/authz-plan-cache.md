---
"@spinajs/authz": minor
---

`@spinajs/authz`: an access plan carries `cache` (`AccessPlanCache`: key, decision tags, TTL) when every model that planned it answers `listPlanCacheable(permission, type)`, the call had no env, the permission is not `fresh`, no model failed and every nested check it rested on could be cached. New port `AuthzCacheTags`, which renders those tags for a cache outside authz; nothing registers it yet, so nothing is cached.
