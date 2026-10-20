# `@spinajs/log-otlp`

A `@spinajs/log` target that exports log entries to any OTLP/HTTP receiver (the OpenTelemetry Collector, Grafana via OTel, Datadog, and others). It batches entries, maps each to an OTLP `LogRecord` and POSTs the JSON payload to `${endpoint}/v1/logs`, with retry for transient failures.

It does **not** export traces or metrics, and it does **not** speak OTLP/gRPC or OTLP/HTTP-protobuf. It sends OTLP/HTTP with a JSON body only.

## Install

```sh
npm install @spinajs/log-otlp
```

Importing the package registers `OtlpLogTarget` in DI under the name `"OtlpLogTarget"`. A logger target with `type: "OtlpLogTarget"` then resolves it.

## Features

| Feature | What it does |
| --- | --- |
| [OTLP log target](01-otlp-log-target.md) | `OtlpLogTarget`: configuration, write and flush flow, DI registration, one instance per target name |
| [OTLP log record mapping](02-otlp-log-record-mapping.md) | How an `ILogEntry` becomes an OTLP `LogRecord`: severity, body, attributes, `exception.*`, trace context |
| [Delivery, retry and buffering](03-delivery-retry-and-buffering.md) | The batch queue, the retry policy, `Retry-After`, requeue on transient errors, drop on permanent ones |
| [Drop hook and fallback targets](04-drop-hook-and-fallback.md) | `OnDropped`: where undelivered entries go, and spilling them to a durable target with `FallbackGroupTarget` |
| [Extending the OTLP target](05-extending-the-otlp-target.md) | Subclass or replace `OtlpLogTarget`: enrich or redact entries, change the retry policy, customise the HTTP client |
| [Building your own OTLP exporter](06-building-your-own-otlp-exporter.md) | Reuse `toOtlp`, `toLogRecord`, `anyValue`, `kv`, `isRetryableOtlpError` and `retryAfterMs` in your own target |

## Quick start

Send every log entry at `info` or above to a local OpenTelemetry Collector. This object is the `logger` section of your configuration.

```ts sample
import '@spinajs/log-otlp';

export const logger = {
  targets: [
    { name: 'Console', type: 'ConsoleTarget' },
    {
      name: 'Otlp',
      type: 'OtlpLogTarget',
      options: {
        endpoint: 'http://localhost:4318',
        headers: { Authorization: 'Bearer <collector-token>' },
        resource: { 'service.name': 'billing-api', 'deployment.environment': 'production' },
      },
    },
  ],
  rules: [
    { name: 'LogOtlpTarget', level: 'warn', target: 'Console', final: true },
    { name: '*', level: 'info', target: ['Console', 'Otlp'] },
  ],
};
```

The first rule sends the target's own diagnostic logger (`LogOtlpTarget`) to the console only; the OTLP target never exports it. See [Important behaviour](01-otlp-log-target.md#important-behaviour).

## Related packages

- [`@spinajs/log`](../log/README.md): loggers, rules, the target contract, `FallbackGroupTarget` and `BatchQueue`.
- [`@spinajs/di`](../di/README.md): the container that resolves the target by its `type` name; see [Lifetimes](../di/04-lifetimes.md) for `@PerInstanceCheck()`.
- `@spinajs/util`: the `ResiliencePipelineBuilder` the export retry is built on.
- `@spinajs/http`: its request id middleware puts `traceId` and `spanId` into the log context, which this target exports as the record's trace context.
