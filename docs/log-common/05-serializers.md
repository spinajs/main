# Serializers

A serializer turns the value of one named log field into a log-friendly form before any target sees it. The registry ships one for `error`; add your own to shrink, mask or reshape other fields. `safeStringify()` is the never-throwing `JSON.stringify` targets use for the result.

## How it works

1. **Register.** `serializers` is a module-level `Map<string, LogSerializer>` from field name to function. It starts with `['error', serializeError]`. `registerSerializer(field, fn)` adds or replaces an entry.
2. **Apply.** `createLogMessageObject()` calls `applySerializers(vars)` on the merged variables of every entry. For each registered field:
   1. skip when the field is missing, `null` or `undefined`;
   2. call the serializer;
   3. a defined return value replaces the field; `undefined` keeps the original value;
   4. a throw replaces the field with `{ serializerError: <message> }`.
3. **Render.** Targets render the replaced value: text layouts through `format()`, JSON targets through `safeStringify()`.

## API

| Export | Signature | Meaning |
| --- | --- | --- |
| `LogSerializer` | `(value: unknown) => unknown` | Return the replacement, or `undefined` to keep the value. |
| `serializers` | `Map<string, LogSerializer>` | The global registry. |
| `registerSerializer` | `(field: string, fn: LogSerializer) => void` | Add or override the serializer for `field`. |
| `applySerializers` | `(vars: Record<string, unknown>) => void` | Run the registry over `vars`, mutating it. Never throws. |
| `serializeError` | `(err: unknown) => ISerializedError \| undefined` | `undefined` for a non-`Error`; otherwise the record below. Never throws. |
| `ISerializedError` | `{ name: string; message: string; stack?: string; code?: string \| number; signal?: string }` | The serialized error. |
| `safeStringify` | `(value: unknown, indent?: number) => string` | `JSON.stringify`, then a retry that writes `"[Circular]"` for repeated objects, then `String(value)`, then `"[unserializable value]"`. |

### `serializeError()` output

| Key | Value |
| --- | --- |
| `name` | `err.name`, or `'Error'` when it is not a string |
| `message` | `err.message`, or `''` when it is not a string |
| `stack` | The error's stack (or message), then each `cause` and each `AggregateError.errors` entry on its own `Caused by: ` line. Cycles are skipped; the walk stops 10 levels deep. |
| `code` | `err.code` when it is a string or number, eg. `ECONNREFUSED` |
| `signal` | `err.signal` when it is a string, eg. `SIGTERM` |

A getter that throws while being read is treated as missing. If serialization still fails, the result is `{ name: 'Error', message: '[unserializable error]' }`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Field serializers | Not in DI; the module-level `serializers` map, process-wide | `error` → `serializeError` | none shipped | `registerSerializer(field, fn)` adds a field or replaces one. To extend the `error` serializer, call `serializeError()` inside yours and add keys to its result. |

### Custom serializer

Register a serializer when a field holds an object that is too large, sensitive or opaque to log as is: an ORM model, a request, a user with a password hash. Register it once at startup, before the first log call that carries the field.

```ts sample
import { createLogMessageObject, LogLevel, registerSerializer, serializeError } from '@spinajs/log-common';

interface IUser {
  id: number;
  email: string;
  passwordHash: string;
}

// Keep only the id and a masked email of any `user` field.
registerSerializer('user', (value) => {
  const user = value as Partial<IUser>;
  if (typeof user.id !== 'number') return undefined;
  const [local, domain] = String(user.email ?? '').split('@');
  return { id: user.id, email: domain ? `${local.charAt(0)}***@${domain}` : undefined };
});

// Extend the default `error` serializer with the HTTP status some errors carry.
registerSerializer('error', (value) => {
  const base = serializeError(value);
  if (!base) return undefined;
  const status = (value as { status?: unknown }).status;
  return typeof status === 'number' ? { ...base, status } : base;
});

const user: IUser = { id: 42, email: 'jane@example.com', passwordHash: '$2b$10$...' };
const notFound = Object.assign(new Error('Invoice not found'), { status: 404 });
const entry = createLogMessageObject(notFound, 'Download failed', LogLevel.Warn, 'billing', { user });

console.log(entry.Variables.user); // { id: 42, email: 'j***@example.com' }
console.log(entry.Variables.error); // { name: 'Error', message: 'Invoice not found', stack: '...', status: 404 }
```

## Important behaviour

- The registry is global. A serializer registered by one package applies to every logger in the process.
- Serializers match top-level field names only. A `user` nested inside another field is not serialized.
- The lookup is by field name, not by type. Any field named `error` goes through the `error` serializer, including one passed in a structured call (`log.warn({ error: err }, ...)`).
- `applySerializers()` mutates the variables object it gets. In `createLogMessageObject()` that object is new for each entry, so caller objects are not changed; the value a serializer returns must also be a new object for the same reason.
- A serializer for `message`, `level` or `logger` changes the core fields every target renders.
- `${error:message}` keeps working with a custom `error` serializer only when its result still has a `message` key.

## Best practices

- Return `undefined` for values your serializer does not recognise, as `serializeError()` does for a non-`Error`. The original value is then kept.
- Use `safeStringify()` instead of `JSON.stringify()` in custom targets; a circular object in a field must never throw out of `write()`.

## Patterns and antipatterns

```ts
// Don't: mutating the value changes the caller's object, which is still in use.
registerSerializer('user', (value) => {
  delete (value as { passwordHash?: string }).passwordHash;
  return value;
});

// Do: return a new object.
registerSerializer('user', (value) => {
  const { passwordHash, ...safe } = value as { passwordHash?: string };
  return safe;
});
```

## Related

- [Log entries](03-log-entries.md): when serializers run.
- [Log targets](06-log-targets.md): where the serialized values are rendered.
