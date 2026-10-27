---
"@spinajs/telemetry": patch
---

`TelemetryBootstrapper` publishes each perf sink under its own type as a cache entry instead of an `asValue` binding, so `clearCache()` drops it together with the `Metrics` it writes to.
