# Long-lived spans

`LongSpanRegistry` keeps spans open under a string key, for flows that last minutes and span several handlers. Open the span when the flow starts, add events from any handler that knows the key, and close it from whichever handler sees the terminal state. Use it for payment transactions, device sessions or multi-step jobs; for one async call, use [`OtelTracing.withSpan()`](01-tracing-service.md).

## How it works

1. `open(key, name, attrs?)`:
   1. closes a span already open under `key`: attribute `replaced: true`, status `ERROR` with message `replaced by a new span on the same key`, `end()`;
   2. starts a new root span `name` with `attrs` on `OtelTracing.tracer('spinajs')`;
   3. stores it with the open time (`Date.now()`) and starts the sweep timer when it is not running.
2. `event(key, name, attrs?)` adds a span event. `setAttributes(key, attrs)` adds attributes. `has(key)` tells whether a span is open under `key`.
3. `childSpan(key, name, attrs, fn)` runs `fn` inside a short span:
   1. with an open span under `key`, the child is started in `trace.setSpan(ROOT_CONTEXT, parent)`, so it is a child of the long span;
   2. otherwise in `context.active()`, a standalone span;
   3. on success status `OK` and the result is returned; on a throw `recordException()`, status `ERROR` with the message, and the error is re-thrown; `end()` runs in both cases.
4. `close(key, status, attrs?)` sets `attrs`, sets status `OK` for `'ok'` or `ERROR` for `'error'`, ends the span and removes the key. With no span left, the sweep timer stops.
5. The sweep timer calls `sweep()` every `otel.longSpan.sweepIntervalMs`. `sweep()` ends every span open for `otel.longSpan.maxAgeMs` or longer: attribute `orphaned: true`, status `ERROR` with message `span outlived otel.longSpan.maxAgeMs`, and a `warn` log entry.
6. `dispose()` closes every open span with `close(key, 'error', { shutdown: true })` and stops the timer.

```mermaid
sequenceDiagram
  participant Start as Payment start handler
  participant Kiosk as Kiosk command handler
  participant End as Terminal-state handler
  participant Registry as LongSpanRegistry
  participant Tracing as OtelTracing
  Start->>Registry: open('txn-81', 'payment.transaction', attrs)
  Registry->>Tracing: tracer('spinajs').startSpan()
  Kiosk->>Registry: childSpan('txn-81', 'kiosk.command', attrs, fn)
  Registry->>Tracing: startSpan(name, attrs, parent context)
  Kiosk->>Registry: event('txn-81', 'cash.inserted', { amount })
  End->>Registry: close('txn-81', 'ok', { state })
  Note over Registry: span ended, exported by OtelTracing's processor
```

## API

| Method | Key | Meaning |
| --- | --- | --- |
| `open(key: string, name: string, attrs?: Attributes)` | required | Opens a root span; replaces a span open under the same key |
| `event(key: string \| undefined, name: string, attrs?: Attributes)` | optional | Adds an event; no-op for `undefined` or an unknown key |
| `setAttributes(key: string, attrs: Attributes)` | required | Adds attributes; no-op for an unknown key |
| `has(key: string)` | required | `true` while a span is open under `key` |
| `close(key: string, status: 'ok' \| 'error', attrs?: Attributes)` | required | Sets attributes and status, ends the span, removes the key; no-op for an unknown key |
| `childSpan<T>(key: string \| undefined, name: string, attrs: Attributes, fn: () => Promise<T>)` | optional | Runs `fn` in a span parented into the long span, or standalone |
| `sweep()` | none | Ends spans older than `otel.longSpan.maxAgeMs` as orphaned. The timer calls it; it is public for tests |
| `dispose()` | none | Ends every open span with status `ERROR` and `shutdown: true` |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `otel.longSpan.maxAgeMs` | `number` | `1800000` (30 min) | Milliseconds; `0` makes every span orphaned on the next sweep | Age at which `sweep()` force-closes a span |
| `otel.longSpan.sweepIntervalMs` | `number` | `60000` | Milliseconds | How often the timer calls `sweep()` |

Spans are exported only when `OtelTracing` is started; see [Tracing service](01-tracing-service.md#configuration) for `otel.enabled` and the exporter keys.

```ts
// src/config/otel.ts of your app: payments never take longer than 10 minutes
export default {
  otel: {
    enabled: true,
    longSpan: {
      maxAgeMs: 10 * 60_000,
      sweepIntervalMs: 30_000,
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `LongSpanRegistry` | `LongSpanRegistry` (class name), `@Singleton()`; registered by `@Injectable()` at import; resolved by type | `LongSpanRegistry` | none shipped | `@Injectable(LongSpanRegistry)` on a subclass, after this package is imported and before the first resolve. Override the public methods and call `super`. See [Customizing the long-span registry](05-customizing-the-long-span-registry.md) |
| Tracing dependency | `@Autoinject(OtelTracing)` on the protected `tracing` property | `OtelTracing` | Your `OtelTracing` subclass | Replacing `OtelTracing` in DI changes the tracer the registry uses. See [Customizing the tracing service](04-customizing-the-tracing-service.md) |

### `LongSpanRegistry`: custom implementation

Subclass it to add attributes every span needs, or to mirror span state elsewhere. The span map and the sweep timer are `private`: a subclass works through the public methods and `super`.

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { Attributes } from '@opentelemetry/api';
import { LongSpanRegistry } from '@spinajs/telemetry-otel';

// Every payment span carries the site it runs at, so the backend can filter by it.
@Singleton()
@Injectable(LongSpanRegistry)
export class SiteLongSpanRegistry extends LongSpanRegistry {
  public open(key: string, name: string, attrs?: Attributes): void {
    super.open(key, name, { 'site.id': process.env.SITE_ID ?? 'unknown', ...attrs });
  }
}
```

More variants are in [Customizing the long-span registry](05-customizing-the-long-span-registry.md).

## Important behaviour

- **Observability never breaks the flow.** `open()`, `event()`, `setAttributes()` and `close()` catch every error and log it at `warn` on the `otel` logger. `childSpan()` catches errors of starting the span and still runs `fn`; errors of `fn` itself are re-thrown.
- **`sweep()` is guarded too.** A span that throws while closing is logged at `warn` and dropped; the sweep goes on with the other spans.
- **One span per key.** `open()` on a key that is open ends the old span as `replaced` with status `ERROR`. Keys must be unique per flow: a transaction id, not a kiosk id.
- **The registry works while tracing is disabled.** With no provider, spans come from the no-op tracer, but keys are stored, `has()` returns `true` and the sweep timer runs. Nothing is exported.
- **The tracer name is fixed** to `spinajs` for `open()` and `childSpan()`. It is the instrumentation scope your backend shows for these spans.
- **`childSpan()` with a key ignores the active context.** The parent context is built from `ROOT_CONTEXT` plus the long span, so baggage or another active span is not carried over.
- **A child of a closed or unknown key is standalone.** `childSpan()` looks the key up when it starts; it does not fail.
- **The sweep timer is lazy and `unref()`'d.** It starts on the first `open()`, stops when the last span closes, and never keeps the process alive. `sweepIntervalMs` is read when the timer starts; `maxAgeMs` on every sweep.
- **Orphans are found late.** A span is force-closed between `maxAgeMs` and `maxAgeMs + sweepIntervalMs` after it opened.
- **Spans are in memory only.** A restart loses open spans without ending them, so they are never exported. A flow resumed after a restart needs a new `open()`.
- **Open spans are ended before the provider shuts down.** On `resolve()` the registry hooks into `OtelTracing.dispose()`, so spans still open are closed as `error` with `shutdown: true` and exported even though `OtelTracing` is disposed first.

## Best practices

- Use the business id of the flow as the key (`transaction.id`), and also put it in `attrs` so the backend can search for it.
- Close from the handler that sees the terminal state, with `'error'` for failures and cancellations, and the final state in `attrs`.
- Pass `undefined` to `event()` and `childSpan()` when the handler may run outside a flow; both accept it, so you need no `if`.
- Set `otel.longSpan.maxAgeMs` a little above the longest flow you expect; anything older is a lost terminal message.
- Wrap remote calls of the flow (device commands, payment gateway calls) in `childSpan()`; they then show in the transaction waterfall with their own timing.

## Patterns and antipatterns

```ts
// Don't: the device id is shared by every transaction on that device; the second open() ends the first as "replaced"
registry.open(`kiosk-${kioskId}`, 'payment.transaction');

// Do: one key per flow
registry.open(`txn-${transactionId}`, 'payment.transaction', { 'transaction.id': transactionId, 'kiosk.id': kioskId });
```

```ts
// Don't: one withSpan cannot cover a flow that ends in another handler
await tracing.withSpan('payment.transaction', {}, async () => startPayment()); // ends before the payment completes

// Do: open in the start handler, close in the terminal-state handler
registry.open(key, 'payment.transaction');
// ... later, in another handler
registry.close(key, 'ok', { state: 'completed' });
```

## Examples

### Trace a cash payment across its handlers

```ts sample
import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import { LongSpanRegistry } from '@spinajs/telemetry-otel';

interface KioskClient {
  send(command: string): Promise<void>;
}

@Singleton()
@Injectable()
export class CashPaymentFlow {
  @Autoinject(LongSpanRegistry)
  protected spans!: LongSpanRegistry;

  public async start(transactionId: string, amount: number, kiosk: KioskClient): Promise<void> {
    const key = `txn-${transactionId}`;
    this.spans.open(key, 'payment.transaction', { 'transaction.id': transactionId, 'payment.amount': amount });

    await this.spans.childSpan(key, 'kiosk.command', { command: 'enableAcceptors' }, () => kiosk.send('enableAcceptors'));
  }

  public onCashInserted(transactionId: string, amount: number): void {
    this.spans.event(`txn-${transactionId}`, 'cash.inserted', { amount });
  }

  public onCompleted(transactionId: string, change: number): void {
    this.spans.close(`txn-${transactionId}`, 'ok', { state: 'completed', 'payment.change': change });
  }

  public onCancelled(transactionId: string, reason: string): void {
    this.spans.close(`txn-${transactionId}`, 'error', { state: 'cancelled', 'cancel.reason': reason });
  }
}
```

### Export the spans still open at shutdown

```ts sample
import { DI } from '@spinajs/di';
import { LongSpanRegistry, OtelTracing } from '@spinajs/telemetry-otel';

export async function shutdown(): Promise<void> {
  const registry = await DI.resolve(LongSpanRegistry);
  const tracing = await DI.resolve(OtelTracing);

  // Ends open spans (status ERROR, shutdown: true) while the provider can still export them.
  await registry.dispose();
  await tracing.flush();

  await DI.dispose();
}
```

## Related

- [Tracing service](01-tracing-service.md): the provider and tracers the registry uses.
- [Customizing the long-span registry](05-customizing-the-long-span-registry.md): subclass or replace `LongSpanRegistry`.
- [Span processors](03-span-processors.md): test the spans the registry produces with an in-memory exporter.
- [Service lifecycle](../di/10-service-lifecycle.md): dispose order of cached services.
