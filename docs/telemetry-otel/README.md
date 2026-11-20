# `@spinajs/telemetry-otel`

OpenTelemetry trace export for SpinaJS. `OtelTracing` attaches an OTLP/HTTP span processor (JSON body, highlight.io endpoint by default) to the shared tracer provider of `@spinajs/tracing`, so every framework span (HTTP, policy, authz, ORM, queue) is exported along with your own. `LongSpanRegistry` keeps keyed spans open for minutes across handlers, eg. one span per payment transaction.

It does **not** own a provider: the service name, resource attributes and sampler come from `tracing.*` of `@spinajs/tracing`. It does **not** export under an external OpenTelemetry SDK, or with `tracing.enabled: false`: `start()` warns and stays inactive. It does **not** start before DI resolves `OtelTracing`, which must happen after the configuration resolves. It does **not** export logs or metrics: logs go through [`@spinajs/log-otlp`](../log-otlp/README.md), metrics through `@spinajs/telemetry`.

## Install

```sh
npm install @spinajs/telemetry-otel
```

Importing the package registers `OtelTracing` and `LongSpanRegistry` in the root DI container, both as singletons. Its default config (`otel.*`, tracing off) is picked up from `lib/config/otel.js` by `@spinajs/configuration`.

## Features

| Feature | What it does |
| --- | --- |
| [Tracing service](01-tracing-service.md) | `OtelTracing`: the `otel.*` config, `start()`, `tracer()`, `withSpan()`, `flush()`, `dispose()`, what is exported, and the disabled no-op mode |
| [Long-lived spans](02-long-lived-spans.md) | `LongSpanRegistry`: open a span under a key, add events from any handler, close it on the terminal state, orphan sweep |
| [Span processors](03-span-processors.md) | The `start( processor )` override: in-memory export for tests, console export, fan-out and filtering processors |
| [Customizing the tracing service](04-customizing-the-tracing-service.md) | Subclass or replace `OtelTracing`: auto-start, auth headers, sampling |
| [Customizing the long-span registry](05-customizing-the-long-span-registry.md) | Subclass or replace `LongSpanRegistry`: default attributes, a recording test double |

## Extension points at a glance

| Extension point | DI token and lifetime | Default | Page |
| --- | --- | --- | --- |
| Tracing service | `OtelTracing`, `@Singleton()`, registered by `@Injectable()` at import | `OtelTracing` | [Customizing the tracing service](04-customizing-the-tracing-service.md) |
| Long-span registry | `LongSpanRegistry`, `@Singleton()`, registered by `@Injectable()` at import | `LongSpanRegistry` | [Customizing the long-span registry](05-customizing-the-long-span-registry.md) |
| Span processor | argument of `OtelTracing.start( processorOverride? )`, not a DI service; added to the hub of `@spinajs/tracing` | `BatchSpanProcessor` over `OTLPTraceExporter` | [Span processors](03-span-processors.md) |

## Quick start

Name the service under `tracing`, turn the export on under `otel`, then start the service once the configuration has resolved:

```ts
// src/config/otel.ts of your app
export default {
  tracing: {
    serviceName: 'billing-api',
    resourceAttributes: { 'highlight.project_id': 'your-project-id' },
  },
  otel: {
    enabled: true,
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

  // Detaches the OTLP processor, which exports the spans still buffered.
  await DI.dispose();
  return pages;
}
```

## Related packages

- [`@spinajs/di`](../di/README.md): registers both services as singletons and injects `OtelTracing` into `LongSpanRegistry`.
- [`@spinajs/configuration`](../configuration/README.md): supplies the `otel.*` keys through `@Config`; read [Injecting config values](../configuration/07-injecting-config-values.md).
- `@spinajs/tracing`: the provider, its hub of span processors and the `tracing.*` keys; this package exports from it.
- [`@spinajs/log`](../log/README.md): both services log under the `otel` logger name; trace ids in log entries come from [Async context and tracing](../log/12-async-context-and-tracing.md), not from this package.
- [`@spinajs/log-otlp`](../log-otlp/README.md): OTLP export for logs, the sibling of this package's trace export.
