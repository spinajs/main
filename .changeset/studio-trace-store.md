---
"@spinajs/studio": minor
---

Spina Studio buffers spans: a `StudioSpanProcessor` attached to the `@spinajs/tracing` hub when Studio mounts (an app that owns its OpenTelemetry SDK adds `studioSpanProcessor()` to it) feeds a per-process `TraceStore` bounded by `studio.buffers.traces`, `studio.buffers.spansPerTrace` and `studio.buffers.traceBytes` (64 MiB by default). `studio.redactAttributes` are masked, values past 2 KiB are cut, SQL bindings are dropped unless `studio.captureBindings`, and Studio's own requests are never recorded.

Attaching the processor switches span recording on for the whole app: without Studio (and without an exporter) tracing is id-only and outbound `traceparent` headers carry the not-sampled flag `00`; with Studio mounted spans are recorded and the flag becomes `01`, so downstream services record as well. `tracing.sampler` still applies; with `tracing.sampler.type: 'never'` nothing is recorded and the `traces` capability is `false`.
