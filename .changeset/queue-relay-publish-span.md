---
"@spinajs/queue": minor
---

The outbox relay now publishes each row under a PRODUCER span `publish <Name>` (`messaging.operation.type: send`, `messaging.operation.name: publish`), one per attempt across every connection of the row. The span is the root of a new trace with a link to the emit's `create <Name>` span, read from the row's headers; a row without a valid `traceparent` gets no link. The relayed message keeps the row's trace headers, so the consumer's `process <Name>` span stays a child of `create`. A failed relay publish ends the span with an ERROR status and `error.type` set to the error's class; the row's retry and backoff are unchanged.
