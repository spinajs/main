---
'@spinajs/queue': minor
---

`OutboxRelay.tick()` claims due `queue_outbox` rows (fenced row leases, several relays drain in parallel), publishes each through `QueueService.publishDirect` and marks it published. A batch stops before a row its claim could not cover (`maxPublishMs`), and a relay that lost a claim never overwrites the new owner's mark.

The outbox writer reads the database clock before it stamps `CreatedAt` and `AvailableAt`, so rows carry database time rather than the application host's.
