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

## Documentation

Full documentation lives in [`docs/log-otlp/`](../../docs/log-otlp/README.md):

- [OTLP log target](../../docs/log-otlp/01-otlp-log-target.md): configuration, flow and DI registration.
- [OTLP log record mapping](../../docs/log-otlp/02-otlp-log-record-mapping.md): how entries become OTLP records.
- [Delivery, retry and buffering](../../docs/log-otlp/03-delivery-retry-and-buffering.md): retry policy, requeue and drop.
- [Drop hook and fallback targets](../../docs/log-otlp/04-drop-hook-and-fallback.md): `OnDropped` and `FallbackGroupTarget`.
- [Extending the OTLP target](../../docs/log-otlp/05-extending-the-otlp-target.md): subclassing and replacing `OtlpLogTarget`.
- [Building your own OTLP exporter](../../docs/log-otlp/06-building-your-own-otlp-exporter.md): reusing the mapping and retry helpers.
