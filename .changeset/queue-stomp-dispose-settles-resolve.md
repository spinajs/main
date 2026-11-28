---
"@spinajs/queue-stomp-transport": patch
---

A `dispose()` of a STOMP connection before its first connect no longer leaves `StompQueueClient.resolve()` pending forever. That covers a `dispose()` right after `resolve()` and one while an `options.beforeConnect` is still running. `resolve()` now rejects with `UnexpectedServerError("Queue connection <name> was disposed before it connected")`, as a pending `whenReady()` already did. Code that started `resolve()` without a rejection handler and then calls `dispose()` now gets an unhandled rejection where it hung before (under `@spinajs/log`: a `fatal` log and exit code 1). A `beforeConnect` or a `webSocketFactory` that fails after `dispose()`, or a socket that `dispose()` closes while it is connecting, no longer logs "connecting anyway", a websocket failure or a websocket error. A container shutdown while the queue factory is still resolving the client at boot is unchanged: it does not reach the client.
