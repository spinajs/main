# Notes client

`connectNotes()` in `src/client.ts` builds a `SocketClient` for the notes server, signed in with a demo token and typed by the [notes contract](01-notes-contract.md). `toBytes()` normalises binary results. `loadSnapshot()` lives in the same module; see [Snapshot stream and resume](07-snapshot-stream.md).

## How it works

1. `connectNotes(url, path, token, options)` creates `new SocketClient({ url, path, clientId: 'notes-<random uuid>', auth: () => ({ token }), io: { transports: ['websocket'] }, ...options })`.
2. The `auth` provider runs on every connect, so a reconnect sends the token again.
3. It returns `client.typed(notesContract)`, a `NotesClient` (`TypedSocketClient<NotesContract>`): `command`, `stream`, `on`, `once` and `off` check names and payloads at compile time.
4. The client connects on its own. Use `whenOffline: 'wait'` on the first command, or wait for the `state` event to report `'online'`.
5. A refused handshake (unknown token) emits `auth_required` with `{ code: 'unauthenticated', message: 'authentication required' }`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `url` | `string` | none | `http(s)://host:port` | Server URL, eg. `INotesServer.url` |
| `path` | `string` | none | socket.io path | Eg. `INotesServer.path` (`/socket.io`) |
| `token` | `string` | none | `alice-token`, `bob-token` | Demo token sent as `auth.token` |
| `options` | `Partial<SocketClientOptions>` | `{}` | Any `SocketClientOptions` | Spread last: overrides `clientId`, `auth`, `io` and adds `reconnect`, `defaultTimeoutMs` and the rest |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Client options | None: plain options | `connectNotes` defaults | Any `SocketClientOptions` | Pass `options`; they win over the defaults |
| Typed contract | `client.typed(contract)` | `notesContract` | A wider contract | Build your own `SocketClient` and call `typed()` with it; see [Notes contract](01-notes-contract.md#contract-add-a-command) |

### Client: custom options

Pass `options` to tune reconnects and timeouts, or to replace the demo `clientId` and `auth`. The tests pass a fast reconnect policy; a browser app passes a stable `clientId` and a token provider.

```ts sample
import { connectNotes, type NotesClient } from '@spinajs/http-socket-example/lib/client.js';

// A browser-like install id and a token read from storage on every reconnect.
const installId = 'install-8c41f2';
let currentToken = 'alice-token';

function connect(url: string, path: string): NotesClient {
  return connectNotes(url, path, currentToken, {
    clientId: installId,
    auth: () => ({ token: currentToken }),
    reconnect: { minMs: 250, maxMs: 10_000 },
    defaultTimeoutMs: 30_000,
  });
}

const notes = connect('http://127.0.0.1:3000', '/socket.io');
notes.on('auth_required', (error) => console.log(`sign in again: ${error.message}`));
notes.on('notes.changed', (change) => console.log(`${change.by} edited ${change.entity.id} (v${change.version})`));
currentToken = 'bob-token';
```

## Important behaviour

- `clientId` defaults to `notes-<random uuid>`, so no credential ends up in the id the server keeps for the connection, its ordered queues and its idempotency records. The id changes on every call; real apps pass a stable, non-secret id per install.
- `io.transports` is `['websocket']`: no HTTP long-polling fallback. A proxy that blocks WebSocket upgrades blocks the client.
- `toBytes(data)` returns `data` when it is already a `Uint8Array` (a Node `Buffer`), and wraps an `ArrayBuffer` otherwise; it does not copy.
- `close()` returns `void` on the typed client; `main.ts` awaits it, which has no effect.

## Best practices

- Subscribe with `on()` before the first command, so no `notes.changed` push is missed.
- Use `once('notes.changed', ...)` in tests that wait for one push, as `test/example.test.ts` does.
- Close every client in `afterEach`; an open client keeps reconnecting to a closed server.

## Patterns and antipatterns

```ts
// Default: a random clientId, the credential stays in auth only
connectNotes(url, path, token);

// A stable id per install
connectNotes(url, path, token, { clientId: installId });
```

## Examples

### Follow a document's edits

```ts sample
import { connectNotes } from '@spinajs/http-socket-example/lib/client.js';

async function follow(url: string, path: string, docId: string): Promise<() => void> {
  const notes = connectNotes(url, path, 'bob-token');
  const off = notes.on('notes.changed', (change) => {
    if (change.docId === docId) {
      console.log(`v${change.version} ${change.by}: ${change.entity.text}`);
    }
  });

  const opened = await notes.command('notes.open', { docId }, { whenOffline: 'wait' });
  console.log(`following ${docId} from v${opened.version}`);

  return () => {
    off();
    notes.close();
  };
}

void follow('http://127.0.0.1:3000', '/socket.io', 'welcome');
```

## Related

- [`@spinajs/http-socket-client`](../http-socket-client/README.md): `SocketClient`, `SocketClientOptions`, reconnect, lifecycle events.
- [Principal source](05-principal-source.md): how the server reads `auth.token`.
- [Snapshot stream and resume](07-snapshot-stream.md): `loadSnapshot()`.
