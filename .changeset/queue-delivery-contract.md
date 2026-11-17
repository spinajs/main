---
'@spinajs/queue': minor
---

`decideDelivery()` is the one retry / dead-letter / drop rule every transport executes, with `resolveDeliveryPolicy()` reading the new routing options `backoff` and `onEventFailure` (and `groupBy` for SQS FIFO). `QueueClient.getRouteOption()` is new. `consume()` refuses a route whose delivery options are invalid before it subscribes on any connection, and `QUEUE_ROUTING_CONFIGURATION_SCHEMA` checks them at boot; the schema also states the shape of a `queue.routing` entry (a string, an object, or an array of those). `backoff.delayMs` and `backoff.maxDelayMs` are whole milliseconds; `null`, a boolean and a blank string fail the boot, and so does a blank `groupBy`. Every decided delay is a whole number of milliseconds a Node timer can wait (at most 2^31 - 1). Behaviour change: a job that throws `NonRetryableError` is marked `dead` on its first failure, as `PermanentJobFailure` already was.
