---
"@spinajs/telemetry-otel": major
---

`OtelTracing` no longer creates a private `NodeTracerProvider`: `start()` attaches the OTLP processor to the shared `@spinajs/tracing` hub, so the exporter sees HTTP, policy, authz, ORM and queue spans, not only `OtelTracing.withSpan` spans. Under an external SDK, or with `tracing.enabled: false`, it warns and stays inactive. Breaking: `otel.serviceName` and `otel.resourceAttributes` are removed and no longer read. Set `tracing.serviceName` and `tracing.resourceAttributes` instead; an app that keeps the old keys reports its package name as `service.name`, loses its extra resource attributes, and gets one warning from `OtelTracing.start()` that names the new keys. `OtelTracing` has no `serviceName`, `resourceAttributes` or provider for a subclass to use. The `@opentelemetry/sdk-trace-node`, `@opentelemetry/resources` and `@opentelemetry/semantic-conventions` dependencies are dropped.

An `otel.endpoint` the exporter cannot parse no longer fails the resolve of `OtelTracing`: `start()` logs an error and stays inactive. `dispose()` no longer rejects when the last export fails because the collector is down or slow: it logs a warning and the shutdown goes on.
