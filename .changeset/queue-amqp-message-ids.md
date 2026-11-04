---
"@spinajs/queue-amqp-transport": minor
---

A message's `MessageId` is published as the AMQP `messageId` property and the `x-spinajs-message-id` header, and its `Headers` as AMQP headers. Retries and dead letters keep the `messageId` property. On receipt a message without a `MessageId` in its body takes it from the property or the header, and the standard headers on the delivery (`x-retry-count`, `x-error`, …) are merged into `Headers`. See `docs/queue/13-message-ids-and-headers.md`.
