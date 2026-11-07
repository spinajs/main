---
"@spinajs/http": minor
---

New `ConcurrencyLimit` server middleware (Order -0.4) for load shedding, off by default. With `http.concurrency.enabled` it serves at most `http.concurrency.max` (default 500) requests at once in this process; a request over the cap gets 503 with `Retry-After` (`http.concurrency.retryAfter`, default 1) and `{ error: { code: 'overloaded' } }` and is not counted. A counted request frees its slot when its response finished or its client went away. `InFlight` gives the count now.
