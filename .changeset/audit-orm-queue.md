---
"@spinajs/audit-orm": minor
---

`@spinajs/audit-orm/queue`: `QueueAuditSink` ships a trail as `AuditBatchRecorded` events, split so no message exceeds `audit.queue.maxMessageBytes`, and refuses the black-hole queue connection; `consumeAuditBatches()` stores them in the receiving service's archive of the trail. `@spinajs/queue` is an optional peer, used only by this subpath.

Trust boundary: the consumer stores every well-formed message as genuine events (the publisher's `id`, `source`, `actor`, `at`), so the queue route must be writable only by the shipping applications, and a seal proves integrity only from the moment of archiving. A message is refused whole when an event's `at` is not `toISOString()` text or is more than 5 minutes ahead, a string field is wider than its column, or an optional field is not a string; configure a dead-letter queue for `AuditBatchRecorded`. The refusal names the first event and field. Shipping applications' clocks must be within 5 minutes of the receiving service's; upgrade the receiving service first when a kind or outcome is added.

Erasure window: events buffered or in flight when `forget` runs are blanked when they arrive, keeping their `data_hash`: an arriving event whose subject has an `erasure` event at or after its `at` (in the archive or still in the receiving service's buffer), and, when an `erasure` event arrives from a shipping application, the archived events of its subject up to its `at` in every source; newer events and erasure records keep their payload. An erasure issued in a shipping application without a reader is not covered: issue `forget` in the receiving service. The archive's `seq` is arrival order: order by `at`. `forget(subject)` without a `source` covers every shipping application that shares the archive.
