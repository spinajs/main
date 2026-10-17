# Span processors

`OtelTracing.start( processorOverride )` takes any OpenTelemetry `SpanProcessor` and uses it instead of the default OTLP batch export. Use it to capture spans in memory in tests, print them in development, send them to several backends, or drop noisy spans before export.

## How it works

1. `start(processorOverride?)` returns at once when `otel.enabled` is `false` or a provider exists. The override is then ignored.
2. Without an override, the processor is `new BatchSpanProcessor(new OTLPTraceExporter({ url: otel.endpoint }))`.
3. With an override, that processor is the provider's **only** processor: nothing goes to `otel.endpoint` unless the override sends it there.
4. `NodeTracerProvider` calls `onStart(span, parentContext)` when a recording span starts and `onEnd(span)` when it ends.
5. `OtelTracing.flush()` calls the processor's `forceFlush()`; `OtelTracing.dispose()` calls its `shutdown()` through the provider.

## The `SpanProcessor` contract

`SpanProcessor` comes from `@opentelemetry/sdk-trace-base` (the SDK types re-exported there):

| Method | Called | Meaning |
| --- | --- | --- |
| `onStart(span: Span, parentContext: Context)` | When a recording span starts | The span is still writable: add attributes here |
| `onEnding?(span: Span)` | Optional, experimental in the SDK | Before the span becomes read-only |
| `onEnd(span: ReadableSpan)` | When a recording span ends | Export or forward it; it is read-only now |
| `forceFlush(): Promise<void>` | `OtelTracing.flush()`, provider shutdown | Export everything buffered |
| `shutdown(): Promise<void>` | `OtelTracing.dispose()` | Flush and release resources |

Shipped processors and exporters from `@opentelemetry/sdk-trace-base`:

| Class | Use |
| --- | --- |
| `BatchSpanProcessor(exporter)` | Buffers ended spans and exports them in batches on a timer. The default |
| `SimpleSpanProcessor(exporter)` | Exports each span as it ends. Tests and development |
| `NoopSpanProcessor` | Drops everything |
| `InMemorySpanExporter` | Keeps spans in an array: `getFinishedSpans()`, `reset()` |
| `ConsoleSpanExporter` | Prints spans to the console |
| `OTLPTraceExporter` (`@opentelemetry/exporter-trace-otlp-http`) | OTLP/HTTP with a JSON body. The default exporter |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Span processor | Not in DI: the `processorOverride` argument of `OtelTracing.start()`, held by the provider until `dispose()` | `BatchSpanProcessor` over `OTLPTraceExporter({ url: otel.endpoint })` | `SimpleSpanProcessor`, `NoopSpanProcessor`, any exporter, your own `SpanProcessor` | Pass it to the first `start()` call. To pick it in DI instead, override `start()` in an `OtelTracing` subclass; see [Customizing the tracing service](04-customizing-the-tracing-service.md) |

### Span processor: custom implementation

Write a class that implements `SpanProcessor`. This one sends every span to the default OTLP endpoint and to a second processor, eg. the console during development.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Context } from '@opentelemetry/api';
import { BatchSpanProcessor, ConsoleSpanExporter, ReadableSpan, SimpleSpanProcessor, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OtelTracing } from '@spinajs/telemetry-otel';

export class FanOutSpanProcessor implements SpanProcessor {
  constructor(private readonly targets: SpanProcessor[]) {}

  public onStart(span: Span, parentContext: Context): void {
    for (const target of this.targets) target.onStart(span, parentContext);
  }

  public onEnd(span: ReadableSpan): void {
    for (const target of this.targets) target.onEnd(span);
  }

  public async forceFlush(): Promise<void> {
    await Promise.all(this.targets.map((t) => t.forceFlush()));
  }

  public async shutdown(): Promise<void> {
    await Promise.all(this.targets.map((t) => t.shutdown()));
  }
}

export async function startWithConsoleCopy(): Promise<void> {
  const config = await DI.resolve(Configuration);
  const tracing = await DI.resolve(OtelTracing);

  tracing.start(
    new FanOutSpanProcessor([
      new BatchSpanProcessor(new OTLPTraceExporter({ url: config.get<string>('otel.endpoint') })),
      new SimpleSpanProcessor(new ConsoleSpanExporter()),
    ]),
  );
}
```

## Important behaviour

- **The override replaces the OTLP export.** Wrap a `BatchSpanProcessor(new OTLPTraceExporter(...))` in your processor when you still want spans at `otel.endpoint`.
- **Only the first effective `start()` uses the override.** A second call while a provider exists returns without looking at its argument.
- **`otel.enabled: false` ignores the override too.** Tests that pass an in-memory processor set `otel.enabled` to `true` first.
- **`onStart` and `onEnd` are synchronous and on the hot path.** They run inside every `startSpan()` and `end()` call; keep them cheap and never throw.
- **Only recording spans reach the processor.** With no provider (tracing disabled), no processor method runs.
- `SimpleSpanProcessor` exports as each span ends but does not wait for the export; still `await tracing.flush()` before asserting on network exporters.

## Best practices

- Use `SimpleSpanProcessor(new InMemorySpanExporter())` in tests: spans are in `getFinishedSpans()` as soon as they end, with no network.
- Keep `BatchSpanProcessor` for production: one export per batch, not one per span.
- Put cross-cutting attributes (tenant, region) in `onStart` of a processor when they are known per process but are not resource attributes.
- Filter in a processor, not at call sites: call sites stay simple and the rule lives in one place.

## Patterns and antipatterns

```ts
// Don't: the console processor replaces the OTLP export; production stops receiving traces
tracing.start(new SimpleSpanProcessor(new ConsoleSpanExporter()));

// Do: fan out to both, or pass the console processor only in development
tracing.start(process.env.APP_ENV === 'development' ? new SimpleSpanProcessor(new ConsoleSpanExporter()) : undefined);
```

## Examples

### Assert spans in a unit test

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import { LongSpanRegistry, OtelTracing } from '@spinajs/telemetry-otel';

export async function paymentSpanIsExported(): Promise<boolean> {
  const config = await DI.resolve(Configuration);
  config.set('otel.enabled', true);

  const exporter = new InMemorySpanExporter();
  const tracing = await DI.resolve(OtelTracing);
  tracing.start(new SimpleSpanProcessor(exporter));

  const registry = await DI.resolve(LongSpanRegistry);
  registry.open('txn-1', 'payment.transaction', { 'transaction.id': 'txn-1' });
  registry.event('txn-1', 'cash.inserted', { amount: 200 });
  registry.close('txn-1', 'ok', { state: 'completed' });

  const [span] = exporter.getFinishedSpans();
  const ok = span.name === 'payment.transaction' && span.status.code === SpanStatusCode.OK && span.events[0].name === 'cash.inserted';

  await registry.dispose();
  await tracing.dispose();
  return ok;
}
```

### Drop health-check spans before export

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Context } from '@opentelemetry/api';
import { BatchSpanProcessor, ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OtelTracing } from '@spinajs/telemetry-otel';

export class DropSpansProcessor implements SpanProcessor {
  constructor(
    private readonly inner: SpanProcessor,
    private readonly prefixes: string[],
  ) {}

  public onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext);
  }

  public onEnd(span: ReadableSpan): void {
    if (this.prefixes.some((p) => span.name.startsWith(p))) return;
    this.inner.onEnd(span);
  }

  public forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  public shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

export async function startWithoutHealthChecks(): Promise<void> {
  const config = await DI.resolve(Configuration);
  const tracing = await DI.resolve(OtelTracing);

  const otlp = new BatchSpanProcessor(new OTLPTraceExporter({ url: config.get<string>('otel.endpoint') }));
  tracing.start(new DropSpansProcessor(otlp, ['health.', 'metrics.scrape']));
}
```

## Related

- [Tracing service](01-tracing-service.md): `start()`, `flush()` and `dispose()`, which drive the processor.
- [Customizing the tracing service](04-customizing-the-tracing-service.md): choose the processor inside an `OtelTracing` subclass instead of at the call site.
- [Long-lived spans](02-long-lived-spans.md): the registry whose spans the test example asserts.
