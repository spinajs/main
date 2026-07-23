# `@spinajs/log-otlp`

OTLP/HTTP log export target for `@spinajs/log`. Exports SpinaJS logs to any
OTLP-compatible backend ( the OpenTelemetry Collector, Grafana / Tempo / Loki
via OTel, Datadog, ... ) over OTLP/HTTP-JSON, POSTing to `${endpoint}/v1/logs`.

Entries are mapped to the OTLP Logs model ( `severityNumber` from the OTel
mapping, `body`, resource + record attributes, `traceId` / `spanId` from the
request trace context, structured errors to `exception.*` semantic attributes ),
buffered with a `BatchQueue`, and retried with the `@spinajs/util` resilience
pipeline ( exponential backoff + jitter, retryable-only, honoring `Retry-After` ).

## Usage

```js
{
  logger: {
    targets: [
      {
        name: "Otlp",
        type: "OtlpLogTarget",
        options: {
          endpoint: "http://localhost:4318",
          headers: { Authorization: "Bearer <token>" },
          resource: { "service.name": "my-service" },
        },
      },
    ],
    rules: [{ name: "*", level: "trace", target: "Otlp" }],
  },
}
```
