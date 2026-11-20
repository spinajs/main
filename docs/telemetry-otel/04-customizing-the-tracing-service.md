# Customizing the tracing service

Subclass `OtelTracing` and register the subclass under the `OtelTracing` key to change how the export starts and what it exports. Every consumer that resolves `OtelTracing`, `LongSpanRegistry` included, gets your class.

## How it works

1. Importing `@spinajs/telemetry-otel` registers `OtelTracing` under the key `OtelTracing` (`@Injectable()` calls `DI.register(OtelTracing).asSelf()`).
2. `@Injectable(OtelTracing)` on your subclass adds it to the same key, and under its own name. A single `resolve()` takes the **last** registration, so your class wins when its module is imported after the package.
3. The first `DI.resolve(OtelTracing)`, or the first resolve of `LongSpanRegistry` through its `@Autoinject(OtelTracing)`, builds your class once (`@Singleton()`) and runs its `resolve()`.
4. Every later resolve returns the cached instance. A registration made after that first resolve affects nothing already built.

## What a subclass can use

| Member | Access | Override to |
| --- | --- | --- |
| `start(processorOverride?)` | public | Change the processor or exporter |
| `active` | public getter | Report your own state |
| `tracer(name)` | public | Hand out other tracers, eg. always the OTel global |
| `withSpan(name, attrs, fn)` | public | Change span creation, eg. make the span active |
| `flush()`, `dispose()` | public | Flush or release what your subclass adds; call `super.dispose()` |
| `resolve()` | public, from `AsyncService` | Run setup when DI builds the service, eg. `start()` |
| `enabled`, `endpoint` | protected `@Config` getters | Read the `otel.*` values |
| `cfg` | protected `@Autoinject(Configuration)` | Read any other key, eg. `tracing.*` |
| `log` | protected `@Logger('otel')` | Log under the `otel` logger |
| `processor`, `detach` | **private** | Not reachable: the provider belongs to `@spinajs/tracing`; add another processor to its hub with `tracingState().hub?.add(processor)` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `OtelTracing` | `OtelTracing` (class name), `@Singleton()`, registered at import of the package | `OtelTracing` | The subclasses on this page; any class with the same public members | `@Injectable(OtelTracing)` (or `DI.register(MyTracing).as(OtelTracing)`) after the package import, before the first resolve of `OtelTracing` or `LongSpanRegistry` |

### Register the replacement in time

- **After** `@spinajs/telemetry-otel` is imported: importing the class you extend already guarantees that.
- **Before** anything resolves `OtelTracing` or `LongSpanRegistry`. Keep the subclass in a module your entry point imports before bootstrap.
- Repeat `@Singleton()` on the subclass: a subclass with its own injection decorators (`@Config`, `@Autoinject`) gets its own descriptor; read [Lifetimes](../di/04-lifetimes.md).
- `Configuration` must be resolved before your `resolve()` or `start()` reads a `@Config` property.

## Important behaviour

- `OtelTracing.dispose()` only detaches its own processor from the hub of `@spinajs/tracing`. The provider and the other processors stay.
- Overriding `start()` and calling `super.start(processor)` keeps the base behaviour: `active`, `tracer()`, `flush()` and `dispose()` keep working unchanged.
- Do not register a second provider as the OTel global. When one is registered before `@spinajs/tracing` starts, it reports `external` and `start()` exports nothing; registered later, it is refused.

## Best practices

- Override the smallest member that does the job: `start()` with `super.start(processor)` covers exporters, headers and processors.
- Add your own config keys with `@Config('otel.<key>', { defaultValue })` on the subclass, next to the package's `otel.*` keys.
- Keep the `!this.enabled` guard in an overridden `start()`: `otel.enabled: false` must stay a full off switch.

## Patterns and antipatterns

```ts
// Don't: registered after LongSpanRegistry was resolved; the registry keeps the original OtelTracing
const registry = await DI.resolve(LongSpanRegistry);
DI.register(HeaderAuthOtelTracing).as(OtelTracing);

// Do: register (import the subclass module) first, then resolve
DI.register(HeaderAuthOtelTracing).as(OtelTracing);
const registry = await DI.resolve(LongSpanRegistry);
```

```ts
// Don't: builds the exporter even when tracing is off, and ignores a processor passed by tests
public start(): void {
  super.start(new BatchSpanProcessor(new OTLPTraceExporter({ url: this.endpoint, headers: this.headers })));
}

// Do: keep the guards and the override parameter
public start(processorOverride?: SpanProcessor): void {
  if (!this.enabled || this.active) return;
  super.start(processorOverride ?? new BatchSpanProcessor(new OTLPTraceExporter({ url: this.endpoint, headers: this.headers })));
}
```

## Examples

### Start tracing when DI resolves the service

```ts sample
import { DI, Injectable, Singleton } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { LongSpanRegistry, OtelTracing } from '@spinajs/telemetry-otel';

@Singleton()
@Injectable(OtelTracing)
export class AutoStartOtelTracing extends OtelTracing {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.start();
  }
}

export async function boot(): Promise<void> {
  await DI.resolve(Configuration);

  // Resolving the registry builds AutoStartOtelTracing through @Autoinject, which starts tracing.
  const registry = await DI.resolve(LongSpanRegistry);
  registry.open('import-2026-10-17', 'catalog.import');
}
```

### Send traces with an auth header from config

Grafana Cloud, Honeycomb and most hosted backends want an auth header. This subclass reads it from a new `otel.headers` key.

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { BatchSpanProcessor, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OtelTracing } from '@spinajs/telemetry-otel';

@Singleton()
@Injectable(OtelTracing)
export class HeaderAuthOtelTracing extends OtelTracing {
  @Config('otel.headers', { defaultValue: {} })
  protected headers!: Record<string, string>;

  public start(processorOverride?: SpanProcessor): void {
    if (!this.enabled || this.active) return;

    super.start(processorOverride ?? new BatchSpanProcessor(new OTLPTraceExporter({ url: this.endpoint, headers: this.headers })));
  }
}
```

```ts
// src/config/otel.ts of your app
export default {
  tracing: {
    serviceName: 'billing-api',
  },
  otel: {
    enabled: true,
    endpoint: 'https://otlp-gateway-prod-eu-west-2.grafana.net/otlp/v1/traces',
    headers: { Authorization: `Basic ${process.env.GRAFANA_OTLP_TOKEN}` },
  },
};
```

### Sample 10% of traces

The provider is the one of `@spinajs/tracing`, registered globally by its bootstrapper, so sampling is its configuration, not a subclass:

```ts
// src/config/tracing.ts of your app
export default {
  tracing: {
    sampler: { type: 'ratio', ratio: 0.1 },
  },
};
```

## Related

- [Tracing service](01-tracing-service.md): the default behaviour these subclasses change.
- [Span processors](03-span-processors.md): processors to pass to `start()` or build inside it.
- [Customizing the long-span registry](05-customizing-the-long-span-registry.md): the registry uses whatever `OtelTracing` resolves to.
- [Registering services](../di/01-registering-services.md): which registration wins and when to register.
