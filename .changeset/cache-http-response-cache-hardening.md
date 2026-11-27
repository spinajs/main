---
"@spinajs/cache-http": minor
---

The README states two security limits of `@ResponseCache`: rows an `.accessible()` or authz-orm-filtered query returned stay in a stored reply until its ttl (at most `cache.maxTtl`) after the caller's access to them was revoked, while a revoked route permission is refused at once; and a hit runs no query, so `@AuditReads` records only the miss.
