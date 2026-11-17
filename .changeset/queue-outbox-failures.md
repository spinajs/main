---
'@spinajs/queue': minor
---

A failed outbox publish is retried with `queue.outbox.backoff` for as long as the row is younger than `queue.outbox.maxAge` (default 24 hours); the first failure after that makes the row `dead`, and it is kept for operators. There is no attempt limit. A row sent to several connections retries only those that did not confirm. Published rows older than `queue.outbox.retention` are purged by the relay. A `crash: true` error is rethrown without writing anything. Each outbox claim now runs from the time of its own statement, so a slow read of the due rows no longer shortens it.
