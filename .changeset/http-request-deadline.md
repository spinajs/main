---
"@spinajs/http": minor
---

New `RequestDeadline` server middleware (Order -0.3), off by default. With `http.deadline.enabled` every request gets an `AbortSignal` in `req.storage.signal` and its deadline (epoch ms) in `req.storage.deadline`, `http.deadline.ms` (default 30000) from when it runs. When the deadline passes, the signal aborts with a `TimeoutError` and a request nothing was sent for yet is answered 504 `{ error: { code: 'deadline_exceeded' } }` through the reply pipeline; a reply coming after it (the action's, an error reply, a 404) is dropped, an error the action throws afterwards is logged at debug level, and an action not started yet is skipped. When the client goes away first, the signal aborts with an `AbortError`. `@Deadline(ms)` (`DeadlineMiddleware`) on a route or controller moves the deadline earlier, never later, and works without `RequestDeadline`. New `HTTP_STATUS_CODE.GATEWAY_TIMEOUT`.
