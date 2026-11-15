---
"@spinajs/tracing": minor
---

New package `@spinajs/tracing`. It registers one OpenTelemetry setup for the app once Configuration resolves (`TracingBootstrapper`): an AsyncLocalStorage context manager, the W3C trace-context and baggage propagator, and a tracer provider whose only processor is a `SpanProcessorHub`. With no processor attached, tracing runs in id-only mode: spans get trace and span ids but nothing is recorded. When an app registered its own OpenTelemetry SDK first, the package leaves it in place (`tracingState().owner === 'external'`). Configuration: `tracing.enabled` (default true), `tracing.serviceName` (default: the app's package.json name), `tracing.resourceAttributes`, `tracing.sampler` (`always | never | ratio | parent-ratio`, default `parent-ratio` with ratio 1). `@spinajs/tracing/testing` adds `useInMemorySpans()`.
