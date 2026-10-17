# `@spinajs/telemetry-otel`

OpenTelemetry tracing for SpinaJS. `OtelTracing` boots a private `NodeTracerProvider` that exports spans over OTLP/HTTP (JSON body, highlight.io endpoint by default). `LongSpanRegistry` keeps keyed spans open for minutes across handlers, eg. one span per payment transaction.

It does **not** register its provider as the OpenTelemetry global, so auto-instrumentation libraries and `trace.getTracer()` do not see it. It does **not** start by itself: your app calls `OtelTracing.start()` after the configuration resolves. It does **not** export logs or metrics: logs go through [`@spinajs/log-otlp`](../log-otlp/README.md), metrics through `@spinajs/telemetry`.

## Install

```sh
npm install @spinajs/telemetry-otel
```

Importing the package registers `OtelTracing` and `LongSpanRegistry` in the root DI container, both as singletons. Its default config (`otel.*`, tracing off) is picked up from `lib/<mjs|cjs>/config/otel.js` by `@spinajs/configuration`.

## Features

| Feature | What it does |
| --- | --- |
| [Tracing service](01-tracing-service.md) | `OtelTracing`: the `otel.*` config, `start()`, `tracer()`, `withSpan()`, `flush()`, `dispose()` and the disabled no-op mode |
| [Long-lived spans](02-long-lived-spans.md) | `LongSpanRegistry`: open a span under a key, add events from any handler, close it on the terminal state, orphan sweep |
| [Span processors](03-span-processors.md) | The `start( processor )` override: in-memory export for tests, console export, fan-out and filtering processors |
| [Customizing the tracing service](04-customizing-the-tracing-service.md) | Subclass or replace `OtelTracing`: auto-start, auth headers, global registration, sampling |
| [Customizing the long-span registry](05-customizing-the-long-span-registry.md) | Subclass or replace `LongSpanRegistry`: default attributes, a recording test double |

## Extension points at a glance

| Extension point | DI token and lifetime | Default | Page |
| --- | --- | --- | --- |
| Tracing service | `OtelTracing`, `@Singleton()`, registered by `@Injectable()` at import | `OtelTracing` | [Customizing the tracing service](04-customizing-the-tracing-service.md) |
| Long-span registry | `LongSpanRegistry`, `@Singleton()`, registered by `@Injectable()` at import | `LongSpanRegistry` | [Customizing the long-span registry](05-customizing-the-long-span-registry.md) |
| Span processor | argument of `OtelTracing.start( processorOverride? )`, not a DI service | `BatchSpanProcessor` over `OTLPTraceExporter` | [Span processors](03-span-processors.md) |

## Quick start

Turn tracing on in your config, then start the service once the configuration has resolved:

```ts
// src/config/otel.ts of your app
export default {
  otel: {
    enabled: true,
    serviceName: 'billing-api',
    resourceAttributes: { 'highlight.project_id': 'your-project-id' },
  },
};
```

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { OtelTracing } from '@spinajs/telemetry-otel';

export async function renderInvoice(invoiceId: string): Promise<number> {
  await DI.resolve(Configuration);

  const tracing = await DI.resolve(OtelTracing);
  tracing.start();

  const pages = await tracing.withSpan('invoice.render', { 'invoice.id': invoiceId }, async (span) => {
    span.addEvent('template.loaded');
    return 3;
  });

  // Shuts the provider down, which exports the spans still buffered.
  await DI.dispose();
  return pages;
}
```

## Related packages

- [`@spinajs/di`](../di/README.md): registers both services as singletons and injects `OtelTracing` into `LongSpanRegistry`.
- [`@spinajs/configuration`](../configuration/README.md): supplies the `otel.*` keys through `@Config`; read [Injecting config values](../configuration/07-injecting-config-values.md).
- [`@spinajs/log`](../log/README.md): both services log under the `otel` logger name; trace ids in log entries come from [Async context and tracing](../log/12-async-context-and-tracing.md), not from this package.
- [`@spinajs/log-otlp`](../log-otlp/README.md): OTLP export for logs, the sibling of this package's trace export.
