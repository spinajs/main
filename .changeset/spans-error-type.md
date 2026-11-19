---
"@spinajs/tracing": minor
"@spinajs/http": minor
---

Framework spans record a failure by its error class only: `withSpan` now defaults to `markSpanErrorType`, and the HTTP server and route spans no longer attach an `exception` event. The error text stays in the log line of the same trace. Pass `markSpanError` to `withSpan` to keep the message on a span of your own.
