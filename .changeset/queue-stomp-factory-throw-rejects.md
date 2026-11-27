---
"@spinajs/queue-stomp-transport": major
---

A websocket factory that throws no longer hangs `StompQueueClient.resolve()`. This covers an `options.webSocketFactory` and a `createWebSocket()` override. Before, the throw happened inside the stompjs connect loop, which nothing awaits: `resolve()` never settled, so `QueueService` boot hung, and the error reached the process as an unhandled rejection with its text unredacted (`@spinajs/log` logs it at `fatal`). A throw on a reconnect stopped the client from reconnecting at all.

Now a throw before the first connect rejects `resolve()` at once with `InvalidArgument("Queue connection <name> cannot open a websocket to <broker>: <reason>")`. Both the broker and the reason have the broker's userinfo, query and secret path parts masked. A throw on a later reconnect is logged at `error` the same way, and the client tries again after `reconnectDelay`. stompjs arms its `connectionTimeout` watcher before the factory runs, and its `deactivate()` does not clear it, so the watcher stays alive for up to `connectionTimeout` ms after such a rejection.

**Breaking:** `options.webSocketFactory` counts only when it is a function. Before, `webSocketFactory: null` made stompjs open the socket with the global `WebSocket` (Node's built-in one, or whatever the application assigned to `globalThis.WebSocket`). Now a `null` means the transport's own `ws` socket, as when the key is unset, and a host that `ws` cannot open rejects at boot. An application that used `null` to get the global `WebSocket` now connects through `ws` and bypasses a global replacement; pass `webSocketFactory: () => new WebSocket(host, Versions.default.protocolVersions())` to keep the global one.
