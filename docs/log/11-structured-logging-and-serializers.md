# Structured logging and serializers

Every entry is a bag of variables, not just a string. JSON targets (`JsonTarget`, `JsonFileTarget`, Loki, OTLP) emit all of them as fields; serializers turn raw values, like an `Error`, into plain JSON-safe records first.

## How it works

1. A level method builds the variables in `createLogMessageObject()`, lowest precedence first:
   1. ambient context from the [context provider](12-async-context-and-tracing.md) (scalars only);
   2. `error` (the `Error` of an error-first call, else `undefined`), `level` (upper case), `logger`, `message`;
   3. logger variables (`addVariable()`), then the fields of an object-shape call.
2. `applySerializers(vars)` runs each registered serializer on its field when the field is set and not `null`:
   - a defined return value replaces the field;
   - `undefined` leaves it unchanged;
   - a thrown error replaces it with `{ serializerError: <message> }`.
3. JSON targets write `{ time, severityNumber, ...variables }` through `safeStringify()`.

## The `error` serializer

`serializeError(err)` returns `undefined` for non-`Error` values, else:

| Field | Value |
| --- | --- |
| `name` | `err.name` |
| `message` | `err.message` |
| `stack` | Stack of the error, then each `cause` and each `AggregateError.errors` member under a `Caused by:` line |
| `code` | `err.code` when a string or number, eg. `ECONNREFUSED` |
| `signal` | `err.signal` when a string, eg. `SIGTERM` |

It never throws; a failure gives `{ name: 'Error', message: '[unserializable error]' }`. It also runs for an `error` field of an object-shape call: `log.warn({ error: err, orderId }, 'retrying ${orderId}')`.

## API

| Export | Signature | Effect |
| --- | --- | --- |
| `registerSerializer` | `(field: string, fn: (value: unknown) => unknown) => void` | Adds or replaces the serializer of `field`, process-wide. |
| `serializers` | `Map<string, LogSerializer>` | The registry. Starts with `error`. |
| `applySerializers` | `(vars: Record<string, unknown>) => void` | Runs the registry over `vars`, in place. |
| `serializeError` | `(err: unknown) => ISerializedError \| undefined` | The default `error` serializer. |
| `safeStringify` | `(value: unknown, indent?: number) => string` | `JSON.stringify`, then a retry that writes `"[Circular]"` for seen objects, then `String(value)`. Never throws. |
| `LogLevelToSeverityNumber` | `Record<LogLevel, number>` | OpenTelemetry severity per level. |
| `renderTemplate`, `renderValue` | | Field templates of the object call shape, see [Logging API](01-logging-api.md#field-templates). |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Field serializer | module-level `serializers` map in `@spinajs/log-common`, keyed by field name | `error` → `serializeError` | | `registerSerializer(field, fn)` at import time; registering `error` replaces the default. |

### Custom serializers

A serializer is keyed by **field name**, so pick names you use consistently (`req`, `user`, `order`) and log objects under them.

```ts sample
import { DI } from '@spinajs/di';
import { Log, registerSerializer, serializeError } from '@spinajs/log';

interface IIncomingRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  ip?: string;
}

registerSerializer('req', (value) => {
  const req = value as IIncomingRequest;
  return { method: req.method, url: req.url, ip: req.ip, userAgent: req.headers['user-agent'] };
});

// Extend the default: keep its output and add the HTTP status an API error carries.
registerSerializer('error', (value) => {
  const base = serializeError(value);
  const status = (value as { status?: unknown })?.status;
  return base && typeof status === 'number' ? { ...base, status } : base;
});

export function logRejectedRequest(req: IIncomingRequest, err: Error): void {
  const log = DI.resolve(Log, ['http.guard']);
  log.warn({ req, error: err, method: req.method }, 'rejected ${method} request');
}
```

## Important behaviour

- Serializers run on every entry of every logger, before filters and targets. Keep them cheap.
- Serializers are global to the process. Registering a name twice keeps the last one.
- A field is serialized only when present and not `null`/`undefined`; `0`, `false` and `''` are serialized.
- Text targets render an object field through the layout: `${req}` inserts the object, `${req:url}` one property.
- Ambient context fields never carry objects (scalars only), so serializers do not apply to them.
- `JsonTarget` and `JsonFileTarget` spread variables after `time` and `severityNumber`; a field with one of those names replaces them.

## Best practices

- Log rich objects under a field with a serializer, never as a printf argument: `%o` produces an unstructured JSON string in `message`.
- Strip secrets in serializers of objects that can carry them (`req.headers.authorization`), or in a [redact filter](10-custom-filters.md#custom-filter-redact-secrets-before-any-target-sees-them).
- Wrap `serializeError` instead of rewriting it, as the sample does, to keep the `cause` chain.

## Patterns and antipatterns

```ts
// Don't: the error becomes text inside message; JSON targets lose name, stack and code
log.error('save failed: %s', err);

// Do
log.error(err, 'save failed');
```

## Examples

### One NDJSON line per checkout, with the cart as a field

```ts sample
import { DI } from '@spinajs/di';
import { Log, registerSerializer } from '@spinajs/log';

interface ICart {
  id: string;
  items: Array<{ sku: string; qty: number; price: number }>;
}

registerSerializer('cart', (value) => {
  const cart = value as ICart;
  return { id: cart.id, lines: cart.items.length, total: cart.items.reduce((sum, i) => sum + i.qty * i.price, 0) };
});

// config: targets: [{ name: 'Json', type: 'JsonTarget' }], rules: [{ name: 'checkout', level: 'info', target: 'Json' }]
export function logCheckout(cart: ICart, userId: string): void {
  DI.resolve(Log, ['checkout']).info({ cart, userId }, 'checkout completed');
  // {"time":"...","severityNumber":9,"level":"INFO","logger":"checkout","message":"checkout completed","cart":{"id":"c-81","lines":3,"total":147.5},"userId":"u-7"}
}
```

## Related

- [Logging API](01-logging-api.md): the call shapes that produce fields.
- [Console, JSON and memory targets](04-console-json-memory-targets.md): what `JsonTarget` writes.
- `@spinajs/log-otlp`: maps `error` to `exception.*` attributes and `severityNumber` to OTLP severity.
