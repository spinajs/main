---
"@spinajs/queue-stomp-transport": patch
---

A `dispose()` of a STOMP connection before its first connect no longer leaves `StompQueueClient.resolve()` pending forever. That covers a `dispose()` right after `resolve()` and one while an `options.beforeConnect` is still running. `resolve()` now rejects with `UnexpectedServerError("Queue connection <name> was disposed before it connected")`, as a pending `whenReady()` already did. A `beforeConnect` or a `webSocketFactory` that fails after `dispose()` no longer logs "connecting anyway" or a websocket failure.
