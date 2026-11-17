---
'@spinajs/queue': major
---

**Breaking:** `QueueService` has a new abstract method, `publishDirect(message, { skip, published })`, which sends to the brokers bypassing the outbox. A class that extends `QueueService` directly must implement it; `DefaultQueueService` and its subclasses need no change.

With `queue.outbox.enabled`, `emit()` inside a transaction on one of `queue.outbox.connections` writes a `queue_outbox` row in that transaction instead of publishing (`mode: 'always'` also writes outside a transaction). Two open outbox transactions throw `OutboxAmbiguousTransaction`; a transaction open on an ORM connection that `queue.outbox.connections` does not list throws `OutboxConnectionNotCovered`, which names the connection to add. A `MessageId` whose outbox row is another message or is dead throws `OutboxMessageIdConflict`; a repeat of the same message is accepted and written once. With the outbox enabled, the Orm boot fails on an outbox connection that does not exist or whose driver has no `orIgnore()` (SQL Server today), and the queue service is resolved as soon as the Orm is, so its queue connections open at boot. `emit()` now checks every routed connection exists before sending to any of them.
