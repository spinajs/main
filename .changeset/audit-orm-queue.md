---
"@spinajs/audit-orm": minor
---

`@spinajs/audit-orm/queue`: `QueueAuditSink` ships a trail as `AuditBatchRecorded` events, split so no message exceeds `audit.queue.maxMessageBytes`, and refuses the black-hole queue connection; `consumeAuditBatches()` stores them in the receiving service's archive of the trail. `@spinajs/queue` is an optional peer, used only by this subpath.
