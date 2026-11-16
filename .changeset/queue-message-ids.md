---
"@spinajs/queue": minor
---

Queue messages carry a `MessageId` and `Headers`. `QueueService.emit()` sets `MessageId` to a uuid v4 unless the caller set one, and a job's `JobId` now defaults to its `MessageId` (a caller-set `JobId` is kept; `emit()` still returns the `JobId` for a job and `undefined` for an event). `QueueMessage` hydrates both fields.

- New exports: `QueueHeaders` (the standard header names `x-spinajs-message-id`, `x-retry-count`, `x-error`, `x-original-destination`, `traceparent`), `QueueHeaderName`, `readQueueHeaders()`, `withoutTransportHeaders()`.
- New subpath `@spinajs/queue/testing`: `MemoryQueueClient` and `MemoryBroker` (an in-memory transport; `options.deferred: true` queues on `emit()` and delivers on `deliverAll()`), `describeQueueTransportConformance()` and `TransportHarness`. It needs `mocha` (optional peer dependency).

See `docs/queue/13-message-ids-and-headers.md`.
