---
"@spinajs/cache-http": minor
---

The README states two security limits of `@ResponseCache`: rows an `.accessible()` or authz-orm-filtered query returned stay in a stored reply until its ttl (at most `cache.maxTtl`) after the caller's access to them was revoked, while a revoked route permission is refused at once; and a hit runs no query, so `@AuditReads` records only the miss.

On a `'tenant'` or `'shared'` route a reply whose `Vary` names `Cookie` or `Authorization` is not stored.

A reply of a `'tenant'` or `'shared'` route keeps only the headers that describe its body (`Content-Type`, `Content-Language`, `Content-Disposition`, `ETag`, `Last-Modified`, `Location`, `Link`, `Cache-Control`, `Expires`, `Vary`); another header the route set is not sent to the next caller.

A reply that says `Cache-Control: no-cache` is not stored.

Every call of the response cache to its cache is bounded by the new setting `cache.http.timeout` (milliseconds, default `250`): a store that does not answer, such as a Redis client queueing while it reconnects, no longer holds the request; it runs uncached, nothing is stored for it, and the route logs a warning.

On a `'tenant'` or `'shared'` route `@Header()` must name its header (`@Header('x-region')`); a `@Header()` without a name fails the registration with a message that says so, instead of refusing a header listed in `vary`. A refused argument is named by its position when http has not named it yet.

On a `'tenant'` or `'shared'` route an action that takes `@Req()` or `@Res()`, or has more parameters than declared arguments (and so reads the `req`, `res`, `next` http passes after them), fails the registration instead of logging a warning: it shared whatever it read of one caller's request with the next caller.

A per-principal reply keeps the same headers as a shared one: a route header that is not one of those, such as the first request's `X-Request-Id`, is not replayed to the principal's later requests.
