---
"@spinajs/telemetry-otel": major
---

Breaking: a span of `OtelTracing.withSpan` or `LongSpanRegistry.childSpan` whose callback throws no longer carries the error's message (3.x set it as the ERROR status message and recorded an `exception` event). It gets `error.type` and an ERROR status with the error's class name (`markSpanErrorType` from `@spinajs/tracing`), because an error's text can hold query parameters and payloads. A backend query or alert that matched on the status message or the `exception` event matches on `error.type` instead; the error's text belongs in the log line of whoever catches it. `@spinajs/tracing` is a new dependency.
