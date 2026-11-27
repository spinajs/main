---
"@spinajs/cache-http": minor
---

The README states two security limits of `@ResponseCache`: rows an `.accessible()` or authz-orm-filtered query returned stay in a stored reply until its ttl (at most `cache.maxTtl`) after the caller's access to them was revoked, while a revoked route permission is refused at once; and a hit runs no query, so `@AuditReads` records only the miss.

On a `'tenant'` or `'shared'` route a reply whose `Vary` names `Cookie` or `Authorization` is not stored.

A reply of a `'tenant'` or `'shared'` route keeps only the headers that describe its body (`Content-Type`, `Content-Language`, `Content-Disposition`, `ETag`, `Last-Modified`, `Location`, `Link`, `Cache-Control`, `Expires`, `Vary`); another header the route set is not sent to the next caller.

A reply that says `Cache-Control: no-cache` is not stored.

Every call of the response cache to its cache is bounded by the new setting `cache.http.timeout` (milliseconds, default `250`): a store that does not answer, such as a Redis client queueing while it reconnects, no longer holds the request; it runs uncached, nothing is stored for it, and the route logs a warning.
