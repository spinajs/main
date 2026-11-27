---
"@spinajs/queue-stomp-transport": patch
---

`StompQueueClient.resolve()` no longer hangs on a broker `host` that `ws` cannot open: a value that is not a URL (`ws://broker:99999/stomp`), a scheme other than `ws:`, `wss:`, `http:`, `https:` or `ws+unix:` (`amqp://broker`, `broker:61613`), a URL with a `#fragment`, or a `ws+unix:` URL without a socket path. Before, `ws` threw inside the stompjs connect loop, which nothing awaits: `resolve()` never settled, so `QueueService` boot hung, and the error reached the process as an unhandled rejection (Node's default crashes the process; `@spinajs/log` logs it at `fatal`). Now `resolve()` rejects at once with `InvalidArgument` naming the connection and the broker without its userinfo, query and fragment, and no socket is opened. The check is skipped when `options.webSocketFactory` is set.
