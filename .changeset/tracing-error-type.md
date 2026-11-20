---
"@spinajs/tracing": minor
---

`markSpanErrorType` records a failure on a span as `error.type` and an ERROR status naming the error's class, without the message or an `exception` event; `errorTypeOf` gives that name. `withSpan` takes the recorder as an optional fourth argument (default `markSpanError`, as before).
