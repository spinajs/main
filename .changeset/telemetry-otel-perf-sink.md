---
"@spinajs/telemetry-otel": minor
---

`OtelPerfSink`: every `Perf` measurement of every package becomes an OpenTelemetry metric of the same name (a counter for `Perf.count`, a histogram in milliseconds for `Perf.measure`, a gauge for `Perf.value`) with its labels as attributes, exported over OTLP/HTTP from a private `MeterProvider` under the resource of the traces (`tracing.serviceName`, `tracing.resourceAttributes`). Off unless `otel.metrics.enabled` is `true`; the new keys `otel.metrics.enabled`, `otel.metrics.endpoint` and `otel.metrics.exportIntervalMs` have a configuration schema.
