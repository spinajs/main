---
"@spinajs/queue": patch
---

An `emit()` that only writes an outbox row is now traced as a PRODUCER span `create <Name>` (`messaging.operation.type` and `messaging.operation.name` set to `create`) instead of `publish <Name>`; the row still carries that span's `traceparent`, and the relay publishes it later. A direct publish keeps `publish <Name>`.
