---
"@spinajs/telemetry-otel": patch
---

Security: `OtelTracing` wrote `otel.endpoint` into the `otel` log as configured, so a credential in the URL (`https://user:secret@host/...`, `?token=...`, `?api_key=...`) reached every log sink of the application: at `info` in `otel export started`, and at `error` in `otel export not started: no OTLP exporter for ...`, whose error object repeated the URL once more. Both lines now print the endpoint without userinfo, query and fragment, with a path segment that may be a token masked as `***`, and the error line no longer carries the exporter's error. The `OtelPerfSink` lines use the same rule. The exporter still receives the configured URL. If a credential was ever part of `otel.endpoint`, treat it as exposed and rotate it; the OTLP exporter does not send userinfo or the query string anyway, so pass the credential as a header (`OTEL_EXPORTER_OTLP_TRACES_HEADERS`).
