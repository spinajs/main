---
"@spinajs/queue": minor
---

`QueueService.emit` publishes under a PRODUCER span `publish <MessageName>` and writes its `traceparent` (and `tracestate`) into the message headers, replacing trace headers a re-emitted message carried. `consume` handles each delivery under a CONSUMER span `process <MessageName>`: a child of the trace in the headers for an ordinary message, the root of a new trace linked to it for a delayed, repeating or cron message (`isScheduledDelivery`), and a new trace when the headers are missing or malformed. A failure is recorded by its error class only. `QueueHeaders.TraceState` is new, `withProducerSpan`, `withConsumerSpan`, `markOutboxCreate` and `isScheduledDelivery` are exported, and the transport conformance suite checks that both trace headers survive a round trip.
