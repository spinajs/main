# Errors and retries

Every promise and iterator of the client fails with a `SocketException`, re-exported from `@spinajs/http-socket-common`. Its `retryable` flag and `retryAfterMs` tell you whether and when to try again. `ReconnectPolicy`, the backoff the client uses for itself, is exported for your own retries.

## How it works

1. A server refusal arrives as a wire `SocketError` `{ code, message, retryable, retryAfterMs?, details?, errorId? }`.
2. The client turns it into a `SocketException` with `SocketException.fromWire()`; every field is kept.
3. Errors the client detects itself (offline, timeout, drop, close) are `SocketException`s built the same way, with the codes below.
4. Invalid arguments to the client (timeouts, `credits`, a durable `key`, constructor options) are `RangeError`s, and `FileOutboxStore` throws a `TypeError` for a payload JSON would change.

### `SocketException`

| Property | Type | Meaning |
| --- | --- | --- |
| `code` | `ErrorCode` | One of `ERROR_CODES`. |
| `message` | `string` | Human-readable reason. |
| `retryable` | `boolean` | Whether the same call can succeed later. |
| `retryAfterMs` | `number`, optional | Server hint: wait at least this long. |
| `details` | `unknown`, optional | Validation errors, limits, the fence predecessor (`{ after }`). |
| `errorId` | `string`, optional | Matches the server log line of an `internal` error. |

### Errors the client produces

| Code | Retryable | Raised by | When |
| --- | --- | --- | --- |
| `unavailable` | no | `command`, `stream`, `durable` | The client is closed. |
| `unavailable` | yes | `command`, `stream` | Offline with `whenOffline: 'fail'`; offline until the timeout with `'wait'`; the connection dropped before the reply or during the stream. |
| `deadline_exceeded` | yes | `command`, `stream` | No reply, or no next stream frame, before `timeoutMs`. |
| `cancelled` | no | `command`, `stream` | The `signal` was aborted. |
| `failed_precondition` | no | `command`, `stream`, `durable` | `command()` or `durable()` on a stream command; `stream()` on a plain command. |
| `internal` | no | `command`, `stream`, `durable` | A malformed reply, a malformed `fail` frame, stream frames out of order, more chunks than granted. |
| `invalid_argument` | no | `durable` | The payload cannot be serialized, or exceeds `durable.maxPayloadBytes`. |

Connection-level refusals do not reject a call; they emit `auth_required`, `incompatible` or `refused` (see [Events](03-events.md#lifecycle-events)).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ReconnectPolicy` | none; the client builds one from `reconnect` for the connection and one for the durable queue | `DEFAULT_RECONNECT`: `minMs` 500, `maxMs` 30 000, `jitter` 0.3 | your own instance with other numbers or a seeded `random` | Construct it yourself for app-level retries. It cannot be injected into `SocketClient`. |

### ReconnectPolicy: reuse for your own retries

`new ReconnectPolicy(options, random?)` validates the options (`minMs >= 0`, `maxMs >= minMs`, `jitter` in `[0, 1]`, else a `RangeError`) and freezes them in `policy.options`. `policy.delay(attempt, retryAfterMs?)` returns the wait before retry `attempt` (0 for the first), with the same rules as the client's own reconnects: exponential, jittered downward, the server hint as a floor capped at `MAX_SERVER_HINT_MS` (300 000). Pass a fixed `random` in tests for exact delays.

```ts sample
import { ReconnectPolicy, SocketClient, SocketException } from '@spinajs/http-socket-client';

const policy = new ReconnectPolicy({ minMs: 250, maxMs: 10_000, jitter: 0.2 });

/** Retries a read while the error says it may succeed later, waiting as the server asks. */
export async function withRetry<T>(call: () => Promise<T>, maxAttempts = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof SocketException) || !error.retryable || attempt + 1 >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, policy.delay(attempt, error.retryAfterMs)));
    }
  }
}

export function loadDashboard(client: SocketClient): Promise<{ widgets: string[] }> {
  return withRetry(() => client.command<{ widgets: string[] }>('dashboard.load', {}, { timeoutMs: 5_000 }));
}
```

## Important behaviour

- `retryable: true` does not mean a plain command did not run. After `unavailable` "the connection dropped before the reply" or `deadline_exceeded`, the server may have run it. Retry only reads and idempotent writes, or use `durable()`.
- The durable queue retries retryable errors itself; its promise rejects only on a permanent refusal or on `close()`.
- The server's `resource_exhausted` for a payload over `maxPayloadBytes` is sent as not retryable: the same payload cannot succeed.
- `retryAfterMs` from the server is a floor. The client caps it at `MAX_SERVER_HINT_MS` for its own reconnects and durable pauses.
- `internal` refusals of the handshake are retried by the connection, unlike other non-retryable handshake refusals.

## Best practices

- Branch on `error instanceof SocketException`, then on `retryable`, then on `code` for the user message.
- Log `errorId` with `internal` errors; it finds the server log line.
- Show `details` of `invalid_argument` next to the form fields; the server puts validation errors there.

## Patterns and antipatterns

```ts
// Don't: retries a non-retryable error forever and ignores the server's hint
while (true) {
  try { return await client.command('reports.build', spec); } catch { await sleep(1000); }
}

// Do
return await withRetry(() => client.command('reports.build', spec));
```

## Examples

### Turn errors into user messages

```ts sample
import { SocketException } from '@spinajs/http-socket-client';

export function describeError(error: unknown): string {
  if (!(error instanceof SocketException)) return 'Something went wrong.';

  switch (error.code) {
    case 'unavailable':
      return error.retryable ? 'You are offline. Try again when the connection is back.' : 'The session has ended. Reload the page.';
    case 'deadline_exceeded':
      return 'The server took too long to answer.';
    case 'forbidden':
      return 'You are not allowed to do this.';
    case 'invalid_argument':
      return `Check the form: ${error.message}`;
    case 'internal':
      return `Server error. Reference: ${error.errorId ?? 'none'}`;
    default:
      return error.message;
  }
}
```

## Related

- [Connection and reconnect](01-connection-and-reconnect.md#backoff): the same backoff, applied to reconnects.
- [Durable commands](04-durable-commands.md): which errors the queue retries and which end in the failed list.
- [`@spinajs/http-socket-common`](../http-socket-common/README.md): `SocketException`, `ERROR_CODES` and `DEFAULT_RETRYABLE`.
- [`@spinajs/http-socket`](../http-socket/README.md): which errors the server sends and when.
