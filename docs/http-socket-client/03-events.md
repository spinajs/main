# Events

`client.on(name, listener)` subscribes to events the server pushes; `client.emit(name, payload)` sends a fire-and-forget event to the server. The same `on`, `once` and `off` also carry the client's own lifecycle events.

## How it works

1. The server sends an `evt` frame `{ name, payload }`.
2. `SocketClient` routes it by name: a name in `LIFECYCLE_EVENTS` never reaches server listeners; any other name goes to the listeners registered with `on(name, ...)`.
3. Listeners run synchronously, in registration order. A listener that throws does not stop the others; its error goes to `onListenerError`.
4. `client.emit(name, payload)` sends an `evt` frame when the client is online and returns `true`. Offline, it drops the event and returns `false`. There is no reply and no retry.

`on()` and `once()` return an `Unsubscribe` function; `off(name, listener)` removes a listener, also one added with `once()`.

### Lifecycle events

| Event | Listener arguments | Fires when |
| --- | --- | --- |
| `state` | `(state, previous)` | The connection state changes. |
| `auth_required` | `(error: SocketError)` | The server refused the handshake as `unauthenticated`, revoked the credential, or `auth()` failed. The client stops. |
| `incompatible` | `(error: SocketError)` | The server answered `version_mismatch`. The client stops. |
| `refused` | `(error: SocketError)` | Any other refusal no retry can fix (`forbidden`, `invalid_argument`). The client stops. |
| `acked` | `({ entry, result })` | A durable command was acknowledged. In send order. |
| `failed` | `({ entry, error })` | The server refused a durable command for good; it is in the outbox's failed list. In send order. |
| `held` | `({ entry, error })` | A durable command was refused as `unauthenticated`; the queue pauses until the connection comes online again. |

`LIFECYCLE_EVENTS` is the exported `ReadonlySet<string>` of these names.

### System events

The server's `sys.shutdown { retryAfterMs }` and `sys.disconnect { reason }` arrive as ordinary server events, so `on('sys.shutdown', ...)` sees them. The connection also acts on them; see [Connection and reconnect](01-connection-and-reconnect.md#server-notices).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `onListenerError` | `(error: unknown) => void` | `rethrowAsync`: throws the error from a `setTimeout(0)` | any function | Gets every error a listener throws, and outbox store failures no caller can be rejected with. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `onListenerError` | none; `onListenerError` option, shared by all listeners of the client and its durable queue | rethrow on a later tick, which surfaces as an uncaught error | your logger or error reporter | Pass a function. If it throws, the error is swallowed so the remaining listeners still run. |
| lifecycle events | none; `on(event, listener)` | no listeners | | Subscribe to the events in the table above. |

### onListenerError: custom implementation

Replace the default when an uncaught error would crash a Node process or flood the browser console. The hook also gets background store failures: a failed `pending()` read at startup or a failed `remove()` after an acknowledgement.

```ts sample
import { SocketClient } from '@spinajs/http-socket-client';

interface ErrorReporter {
  capture(error: unknown, context: Record<string, string>): void;
}

export function createClient(reporter: ErrorReporter, clientId: string): SocketClient {
  const client = new SocketClient({
    url: 'https://app.example.com',
    clientId,
    onListenerError: (error) => reporter.capture(error, { source: 'socket-client', clientId }),
  });

  client.on('docs.committed', (payload) => {
    // a throw here reaches the reporter; other listeners still run
    if (payload === null) throw new Error('empty commit notice');
  });
  return client;
}
```

## Important behaviour

- A server event named like a lifecycle event (`state`, `failed` ...) is unreachable through `on()`. Pick other names on the server.
- `emit()` while offline drops the event and returns `false`; nothing is queued. Use a [durable command](04-durable-commands.md) for anything that must arrive.
- Listeners added before the first connection see every event: the client connects in a microtask after the constructor.
- `once()` removes the listener before calling it, so an `emit` from inside it does not call it again.
- Payload types are not checked at runtime. Use [typed contracts](07-typed-contracts.md) for compile-time checks.

## Best practices

- Keep the `Unsubscribe` returned by `on()` and call it when the component that subscribed goes away.
- Check `emit()`'s return value when the UI should show that an event was not sent.
- Use `state` for connection UI and the three stop events (`auth_required`, `incompatible`, `refused`) for user action.

## Patterns and antipatterns

```ts
// Don't: the listener stays registered after the view is gone and keeps updating a detached element
client.on('docs.committed', (payload) => view.apply(payload));

// Do
const off = client.on('docs.committed', (payload) => view.apply(payload));
view.onDestroy(off);
```

## Examples

### Show live cursors of other users

```ts sample
import { SocketClient } from '@spinajs/http-socket-client';

interface CursorMoved {
  userId: string;
  x: number;
  y: number;
}

export function trackCursors(client: SocketClient, canvas: HTMLElement, draw: (cursor: CursorMoved) => void): () => void {
  const off = client.on<CursorMoved>('docs.cursor', draw);

  const onMove = (event: MouseEvent): void => {
    // fire-and-forget: a lost cursor position is replaced by the next one
    client.emit('docs.cursor', { x: event.offsetX, y: event.offsetY });
  };
  canvas.addEventListener('mousemove', onMove);

  return () => {
    off();
    canvas.removeEventListener('mousemove', onMove);
  };
}
```

### Warn the user before a server restart

```ts sample
import { SocketClient } from '@spinajs/http-socket-client';

export function warnOnShutdown(client: SocketClient, notify: (message: string) => void): void {
  client.on<{ retryAfterMs?: number }>('sys.shutdown', ({ retryAfterMs }) => {
    const seconds = Math.ceil((retryAfterMs ?? 0) / 1000);
    notify(`The server is restarting. Reconnecting in about ${seconds} s.`);
  });
}
```

## Related

- [Connection and reconnect](01-connection-and-reconnect.md): when `state`, `auth_required`, `incompatible` and `refused` fire.
- [Durable commands](04-durable-commands.md): when `acked`, `failed` and `held` fire.
- [Typed contracts](07-typed-contracts.md): typed event names and payloads.
- [`@spinajs/http-socket`](../http-socket/README.md): rooms and server push.
