---
"@spinajs/queue-stomp-transport": patch
---

An `options.beforeConnect` that throws or returns a rejected promise no longer hangs `StompQueueClient.resolve()`. Before, it ran at the top of the stompjs connect loop, which nothing awaits: `resolve()` never settled, so `QueueService` boot hung, and the error reached the process as an unhandled rejection with its text unredacted (a hook that fetches a token or builds headers can quote the broker URL, a token or a password).

Now such a hook, before the first connect, deactivates the client and rejects `resolve()` at once with `InvalidArgument("Queue connection <name>: options.beforeConnect failed: <reason>")`, the broker's userinfo, query and secret path parts masked in the reason. A hook that throws a value that cannot be turned into text (`Object.create(null)`, or an object whose `toString` throws) still rejects, with the fixed reason `a thrown value that cannot be printed` and nothing of the value. On a later reconnect the failure is logged at `error` the same way and the connect goes ahead. A hook that resolves is awaited as before, with the stompjs client as `this`. A value of `options.beforeConnect` that is not a function counts as unset, where stompjs failed calling it.
