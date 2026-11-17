---
'@spinajs/queue': minor
---

`@spinajs/queue/testing`: `MemoryQueueClient` in deferred mode executes the delivery decision on the injected `Clock`: a failed event is dropped unless its route says `onEventFailure: 'retry'`, a failed job is retried `RetryCount` times and then dead-lettered into `deadLettered`, a retry waits its delay. A `NonRetryableError` or `PermanentJobFailure` job is dead-lettered on its first failure. Subscriptions that share a `subscriptionId` compete for one copy of an event. `describeQueueTransportConformance` adds the delivery cases and takes `{ skip }`; `conformanceRouting()`, `CONFORMANCE_ROUTING`, `CONFORMANCE_MAX_DELAY_MS`, `deadLetterBody()` and the optional `TransportHarness.injectRaw` / `redeliverUnsettled` are new.
