---
'@spinajs/queue': minor
---

With `queue.outbox.enabled` and `queue.outbox.relay` (default true), the queue service runs the outbox relay: it ticks every `queue.outbox.tick` ms and right after a transaction that wrote outbox rows commits; a commit that lands while a pass is running gets one more pass as soon as that one ends. The relay starts when the Orm boots, so rows left by an earlier run are published without a first emit. `relay: false` leaves publishing to other replicas. See docs/queue/10-outbox.md.

Passes never overlap, a failing pass is logged and the loop goes on, and disposing the queue service stops the loop within `queue.outbox.claimTtl`, releasing the rows of the pass in flight that it has not published. The writer reads database time again, in the background, on the first emit a minute or more after its last read, so an emit-only process follows a host clock that moves after boot. A queue service that cannot read database time fails to resolve with an `InvalidOperation` that names `db.DefaultConnection`.
