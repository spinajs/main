---
"@spinajs/http": minor
---

New `MaintenanceMode` server middleware (Order 2.5: after CORS, the request id and the access log, before throttling; always mounted). While `HttpServer` is closing it answers every request 503 with `Connection: close` and `{ error: { code: 'shutting_down' } }`, so a request arriving on a kept-alive connection during a graceful shutdown is refused and the client reconnects elsewhere. With `http.maintenance.enabled` (or `MaintenanceMode.enable()` at runtime; `disable()` turns it off) it answers 503 with `Retry-After` (`http.maintenance.retryAfter`, default 60) and `{ error: { code: 'maintenance', message } }` to every request but the `http.maintenance.allow` path prefixes. `http.maintenance` is read once, at the first request.
