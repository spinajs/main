---
"@spinajs/http": minor
"@spinajs/log": minor
---

`@spinajs/http` opens an OpenTelemetry SERVER span per request (`TracingMiddleware`), named `<METHOD> <route template>` once the route matches, with `http.request.method`, `http.route`, `url.path` and `http.response.status_code`; a 5xx sets ERROR. An inbound `traceparent` makes it a child of the caller. `RequestId` takes `req.storage.traceId`/`spanId` from that span and answers `traceparent` through the W3C propagator. `@spinajs/log` adds the `traceId`/`spanId` of the active span to every log line. The traceparent helpers of `@spinajs/log` (`parseTraceparent`, `newTraceContext`, `formatTraceparent`, `randomTraceId`, `randomSpanId`, `ITraceContext`) are deprecated and will be removed in 5.0; use `@spinajs/tracing`. In id-only mode (no span processor attached) and with tracing disabled, the `traceparent` response header carries trace-flags `00`: nothing is recorded, so a downstream parent-based sampler records nothing either.
