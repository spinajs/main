---
"@spinajs/queue-stomp-transport": minor
---

A message's `MessageId` is published as the `x-spinajs-message-id` header (STOMP's `message-id` belongs to the broker) and its `Headers` as STOMP headers, leaving out frame headers such as `destination` and `receipt`. Retries and dead letters keep `x-spinajs-message-id`. On receipt a message without a `MessageId` in its body takes it from that header, and the standard headers on the frame (`x-retry-count`, `x-error`, …) are merged into `Headers`. See `docs/queue/13-message-ids-and-headers.md`.
