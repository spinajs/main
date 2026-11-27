---
"@spinajs/authz": patch
---

The engine's request memo keeps a node's ancestors and scope attributes only once the read has settled; a read still running is no longer handed to a second check. With the ORM's savepoint queue, `AuthzService.check()` on a concrete resource, made twice in one request with one call inside a nested `transaction()`, awaited the ancestor read the other call had started, which waited for a statement queued behind its own savepoint: the check never settled. Scope attributes stalled the same way until `modelTimeoutMs` (2 s by default) and then answered fail-closed. Two checks that overlap on a node's first read now read it each (N reads instead of 1); every later check of the request still gets the kept answer without a read. A failed or timed-out read is no longer kept for the rest of the request, a read that settles after an `invalidate()` is not kept, and what the request kept before an `invalidate()` is read again after it.
