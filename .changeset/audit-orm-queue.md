---
"@spinajs/audit-orm": minor
---

`@spinajs/audit-orm/queue`: `QueueAuditSink` ships a trail as `AuditBatchRecorded` events, split so no message exceeds `audit.queue.maxMessageBytes`, and refuses the black-hole queue connection; `consumeAuditBatches()` stores them in the receiving service's archive of the trail. `@spinajs/queue` is an optional peer, used only by this subpath.

Trust boundary: the consumer stores every well-formed message as genuine events (the publisher's `id`, `source`, `actor`, `at`), so the queue route must be writable only by the shipping applications, and a seal proves integrity only from the moment of archiving. A message is refused whole when an event's `at` is not `toISOString()` text or is more than 5 minutes ahead, a string field is wider than its column, or an optional field is not a string; configure a dead-letter queue for `AuditBatchRecorded`.

Erasure window: events buffered or in flight when `forget` runs in the receiving service are blanked when they arrive (one select per batch finds subjects with an `erasure` event at or after the event's `at`, and redacts them in every source). An erasure issued in a shipping application without a reader is not covered: issue `forget` in the receiving service. The archive's `seq` is arrival order: order by `at`. `forget(subject)` without a `source` covers every shipping application that shares the archive.
