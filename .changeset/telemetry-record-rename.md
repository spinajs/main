---
"@spinajs/telemetry": major
---

`TelemetryMiddleware`'s protected end-of-request method `onFinish(req, res)` is renamed `record(req, res)`: `onFinish` is now a `ServerMiddleware` hook of `@spinajs/http` with another signature. A subclass that overrode `onFinish(req, res)` overrides `record(req, res)` and calls `super.record(req, res)`.
