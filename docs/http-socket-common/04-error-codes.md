# Error codes and `SocketException`

Thirteen error codes, a wire shape `SocketError` that carries one, and `SocketException`, the throwable form both sides use. Server handlers throw `SocketException` to answer with a chosen code; the client rejects command promises with it.

## How it works

1. A server handler throws. `SocketErrorMapper` of `@spinajs/http-socket` turns the error into a `SocketError`:
   - A `SocketException` (or subclass) becomes `error.toWire()`.
   - A mapped spinajs exception (`ResourceNotFound`, `Forbidden`, ...) becomes its code, see the table below.
   - Anything else becomes `internal` with a fresh `errorId`, logged on the server.
2. The server sends the `SocketError` in a `CommandErrorReply`, a `StreamFail` or a handshake `connect_error`.
3. The client checks it with `isSocketError()` and rejects the call with `SocketException.fromWire(error)`.
4. App code catches the `SocketException` and branches on `code`, `retryable`, `retryAfterMs` and `details`.

## Error codes

`ErrorCode` is the union; `ERROR_CODES` lists the same values in this order; `isErrorCode(v)` checks a value.

| Code | Retryable by default | Sent by `@spinajs/http-socket` for |
| --- | --- | --- |
| `invalid_argument` | no | Malformed frames, bad handshake `clientId`, `InvalidArgument`, `BadRequest`, `JsonValidationFailed`, `ValidationFailed`, unserializable payload, credits above the limit. |
| `unauthenticated` | no | `AuthenticationFailed`, a refused principal. |
| `forbidden` | no | `Forbidden`, authz `AccessDenied`, a disallowed origin. |
| `not_found` | no | `ResourceNotFound`. |
| `conflict` | no | `ResourceDuplicated`. |
| `failed_precondition` | no | `InvalidOperation`, a stream command called as a plain command, an idempotency key on a non-idempotent command. |
| `unimplemented` | no | Unknown command, `NotSupported`, `MethodNotImplemented`. |
| `deadline_exceeded` | yes | The command deadline passed; a stream stalled without credit. |
| `cancelled` | no | The client sent a `cancel` frame. |
| `resource_exhausted` | yes | Rate limit, too many commands or streams in flight; payload size limit (sent with `retryable: false`). |
| `unavailable` | yes | Server shutting down, connection closed, durable predecessor not completed. |
| `version_mismatch` | no | Handshake `protocol` differs from `PROTOCOL_VERSION`. |
| `internal` | no | Any unmapped error; carries `errorId`. |

`DEFAULT_RETRYABLE` holds the middle column. `SocketException` uses it when the thrower does not set `retryable`.

## `SocketError`

| Field | Type | Meaning |
| --- | --- | --- |
| `code` | `ErrorCode` | One of the 13 codes. |
| `message` | `string` | Human-readable text. In production an `internal` error carries `Internal server error`. |
| `retryable` | `boolean` | Whether resending the same request can succeed. |
| `details` | `unknown?` | Validation errors, conflicting keys, limits, deny reasons. |
| `retryAfterMs` | `number?` | How long to wait before a retry. |
| `errorId` | `string?` | Matches the server log line of an `internal` error. |

## `SocketException`

```ts
new SocketException(code: ErrorCode, message: string, options?: SocketExceptionOptions)
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `details` | `unknown` | not set | Copied to `details`. |
| `retryable` | `boolean` | `DEFAULT_RETRYABLE[code]` | Overrides the code's default. |
| `retryAfterMs` | `number` | not set | Copied to `retryAfterMs`. |
| `errorId` | `string` | not set | Copied to `errorId`. |
| `cause` | `unknown` | not set | Passed to `Error`'s `cause`. Never sent on the wire. |

| Member | Effect |
| --- | --- |
| `name` | `'SocketException'`. |
| `toWire(): SocketError` | The wire form, without fields that are `undefined`. |
| `static fromWire(error): SocketException` | Rebuilds a `SocketException` from a wire error; `toWire()` of the result equals the input. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SocketException` | none, a plain class | `SocketException` | Your subclasses | Subclass it and override `toWire()`: see [Custom socket exceptions](05-custom-socket-exceptions.md). |
| Error mapping (server) | `SocketErrorMapper`, `@Injectable`, in `@spinajs/http-socket` | Mappings registered with `@HandleSocketException` | Your own `@HandleSocketException` mapping | See [`@spinajs/http-socket`](../../packages/http-socket/README.md). |

`ErrorCode` is a closed union: a 14th code is a protocol change. Put domain-specific detail in `details` instead.

## Important behaviour

- `retryable` is an explicit wire field. The client never infers it from the code, so a thrower can mark a `resource_exhausted` as final, as the payload size limit does.
- `fromWire()` always returns a plain `SocketException`. A server-side subclass arrives on the client as its code, message and details only.
- `cause` stays on the side that threw: it is not part of `toWire()`.
- An unmapped error is never sent as-is. Outside production, `internal` also carries `details: { name, stack }`; in production only the `errorId`.
- `isSocketError()` checks `code`, `message` and `retryable` only.

## Best practices

- Throw `SocketException` from socket handlers when the code matters to the client; throw spinajs exceptions when the same service also serves HTTP, since both map them.
- Retry on `err.retryable`, never on a list of codes, and wait `err.retryAfterMs` when it is set.
- Show `errorId` to users of an `internal` error; it finds the server log line.

## Patterns and antipatterns

```ts
// Don't: a plain Error reaches the client as `internal` with a generic message
throw new Error('document is locked');

// Do: a code and details the client can act on
throw new SocketException('failed_precondition', 'document is locked', { details: { lockedBy: 'anna' } });
```

```ts
// Don't: hard-coded retry list, ignores retryable: false on a size refusal
if (err.code === 'resource_exhausted') retry();

// Do
if (err instanceof SocketException && err.retryable) retry(err.retryAfterMs);
```

## Examples

### Retry a command while the server says it is retryable

```ts sample
import { SocketException } from '@spinajs/http-socket-common';

export async function withRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof SocketException) || !err.retryable || attempt >= attempts) {
        throw err;
      }
      const delayMs = err.retryAfterMs ?? 200 * attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
```

### Answer a rate limit with a retry hint

```ts sample
import { SocketException } from '@spinajs/http-socket-common';

const lastExport = new Map<string, number>();

export function assertExportAllowed(userId: string, now = Date.now()): void {
  const last = lastExport.get(userId) ?? 0;
  const waitMs = last + 60_000 - now;
  if (waitMs > 0) {
    throw new SocketException('resource_exhausted', 'one export per minute', { retryAfterMs: waitMs, details: { limit: 1, windowMs: 60_000 } });
  }
  lastExport.set(userId, now);
}
```

### Show an error to the user

```ts sample
import { SocketException, isErrorCode } from '@spinajs/http-socket-common';

export function describeError(err: unknown): string {
  if (!(err instanceof SocketException) || !isErrorCode(err.code)) {
    return 'Unexpected error';
  }
  switch (err.code) {
    case 'unauthenticated':
      return 'Please sign in again';
    case 'forbidden':
      return 'You do not have access to this';
    case 'internal':
      return `Server error, reference ${err.errorId ?? 'unknown'}`;
    default:
      return err.message;
  }
}
```

## Related

- [Custom socket exceptions](05-custom-socket-exceptions.md): domain subclasses of `SocketException`.
- [Wire protocol](01-wire-protocol.md): the replies and frames that carry a `SocketError`.
- [Handshake](02-handshake.md): how the client reacts to a refused handshake.
- [`@spinajs/http-socket`](../../packages/http-socket/README.md): `SocketErrorMapper` and `@HandleSocketException`.
- [`@spinajs/exceptions`](../exceptions/README.md): the exceptions the server maps to codes.
