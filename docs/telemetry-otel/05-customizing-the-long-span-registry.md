# Customizing the long-span registry

Subclass `LongSpanRegistry` and register it under the `LongSpanRegistry` key to add attributes to every long span, mirror span state into your own code, or swap in a test double. Every consumer that resolves or `@Autoinject`s `LongSpanRegistry` gets your class.

## How it works

1. Importing `@spinajs/telemetry-otel` registers `LongSpanRegistry` under the key `LongSpanRegistry`, as a singleton.
2. `@Injectable(LongSpanRegistry)` on your subclass adds it to the same key. A single `resolve()` takes the last registration, so your class wins when its module is imported after the package.
3. The first resolve builds your class, injects `OtelTracing` into the protected `tracing` property (whatever `OtelTracing` resolves to), and caches it.
4. Your overrides run in place of the base methods; `super.<method>()` runs the base logic: key map, replace-on-open, error guards, sweep timer.

## What a subclass can use

| Member | Access | Override to |
| --- | --- | --- |
| `open()`, `event()`, `setAttributes()`, `close()`, `has()`, `childSpan()` | public | Add attributes, mirror state, validate keys; call `super` to keep the base behaviour |
| `sweep()` | public | Run code around the orphan sweep |
| `dispose()` | public | Run code before the remaining spans close; call `super.dispose()` |
| `tracing` | protected, `@Autoinject(OtelTracing)` | Start extra spans on the same provider |
| `maxAgeMs`, `sweepIntervalMs` | protected `@Config` getters | Read `otel.longSpan.*` |
| `log` | protected `@Logger('otel')` | Log under the `otel` logger |
| span map, sweep timer | **private** | Not reachable: track your own state next to the base map if you need it |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `LongSpanRegistry` | `LongSpanRegistry` (class name), `@Singleton()`, registered at import of the package | `LongSpanRegistry` | The subclasses on this page | `@Injectable(LongSpanRegistry)` (or `DI.register(MyRegistry).as(LongSpanRegistry)`) after the package import, before the first resolve |
| Its tracer source | `OtelTracing`, injected with `@Autoinject` | `OtelTracing` | Your `OtelTracing` subclass | Replace `OtelTracing`; see [Customizing the tracing service](04-customizing-the-tracing-service.md) |

## Important behaviour

- A subclass that skips `super` in `open()` or `close()` also skips the base guards: an error it throws reaches the business flow.
- The base `open()` closes a replaced span itself; a subclass sees only the new `open()` call, not the replacement.
- `sweep()` gives no list of the spans it closed; the base logs each one at `warn` with `spanKey`.
- Repeat `@Singleton()` on the subclass: one shared registry is what lets one handler close a span another handler opened.

## Best practices

- Override `open()` for attributes every flow needs, and spread the caller's `attrs` last so a caller can still override them.
- Keep overrides as cheap as the base: they run inside business handlers.
- In unit tests of business code, replace the registry with a recording double; test spans themselves with an in-memory exporter, as in [Span processors](03-span-processors.md#assert-spans-in-a-unit-test).

## Patterns and antipatterns

```ts
// Don't: the base guard is bypassed; a bad attribute value now throws into the payment handler
public close(key: string, status: 'ok' | 'error', attrs?: Attributes): void {
  this.audit.record(key, status);
}

// Do: call super, and keep your own extra work guarded too
public close(key: string, status: 'ok' | 'error', attrs?: Attributes): void {
  super.close(key, status, attrs);
  try {
    this.audit.record(key, status);
  } catch (err) {
    this.log.warn(`audit of ${key} failed`);
  }
}
```

## Examples

### Tag every long span with the site and count open flows

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { Attributes } from '@opentelemetry/api';
import { LongSpanRegistry } from '@spinajs/telemetry-otel';

@Singleton()
@Injectable(LongSpanRegistry)
export class SiteLongSpanRegistry extends LongSpanRegistry {
  private readonly openKeys = new Set<string>();

  public get openFlows(): number {
    return this.openKeys.size;
  }

  public open(key: string, name: string, attrs?: Attributes): void {
    super.open(key, name, { 'site.id': process.env.SITE_ID ?? 'unknown', ...attrs });
    this.openKeys.add(key);
  }

  public close(key: string, status: 'ok' | 'error', attrs?: Attributes): void {
    super.close(key, status, attrs);
    this.openKeys.delete(key);
  }

  public sweep(): void {
    super.sweep();
    // The base removes orphaned keys from its private map; mirror that here.
    for (const key of this.openKeys) {
      if (!this.has(key)) this.openKeys.delete(key);
    }
  }
}
```

### Assert a flow opens and closes its span, without OpenTelemetry

```ts sample
import { DI, Injectable, Singleton } from '@spinajs/di';
import { Attributes } from '@opentelemetry/api';
import { LongSpanRegistry } from '@spinajs/telemetry-otel';

interface RecordedCall {
  method: 'open' | 'event' | 'close';
  key: string | undefined;
  name: string;
}

@Singleton()
@Injectable(LongSpanRegistry)
export class RecordingLongSpanRegistry extends LongSpanRegistry {
  public readonly calls: RecordedCall[] = [];

  public open(key: string, name: string, _attrs?: Attributes): void {
    this.calls.push({ method: 'open', key, name });
  }

  public event(key: string | undefined, name: string, _attrs?: Attributes): void {
    this.calls.push({ method: 'event', key, name });
  }

  public close(key: string, status: 'ok' | 'error', _attrs?: Attributes): void {
    this.calls.push({ method: 'close', key, name: status });
  }

  public async childSpan<T>(_key: string | undefined, _name: string, _attrs: Attributes, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export async function refundClosesItsSpan(): Promise<boolean> {
  const registry = (await DI.resolve(LongSpanRegistry)) as RecordingLongSpanRegistry;

  // The code under test.
  registry.open('refund-77', 'payment.refund');
  registry.close('refund-77', 'ok');

  return registry.calls.map((c) => `${c.method}:${c.name}`).join(',') === 'open:payment.refund,close:ok';
}
```

## Related

- [Long-lived spans](02-long-lived-spans.md): the base behaviour these subclasses extend.
- [Customizing the tracing service](04-customizing-the-tracing-service.md): change the tracer source the registry uses.
- [Registering services](../di/01-registering-services.md): which registration wins and when to register.
