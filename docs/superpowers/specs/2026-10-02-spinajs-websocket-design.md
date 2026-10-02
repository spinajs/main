# spinajs WebSocket layer: commands, events, streams, resilience — design

Status: ACCEPTED · 2026-10-02 (§9 answered) · step S2 of the editor server spec
(`2026-10-02-editor-server-sync-mcp-design.md` §14)

**Location.** This spec moves to the Spinajs repo when S2 starts. It is written here because the Spinajs checkout
(`SourceCodes/Spinajs/main`) is on branch `fix/rbac-cli-orm` with uncommitted work.

## 1. Goal

Give every spinajs app a generic, reusable WebSocket layer with server and client sides. Nothing in it is specific to
the editor.

| Need | Provided by |
|---|---|
| Request/response calls with typed results and errors | **Commands** |
| Server-to-client push, to one connection or a group | **Events** and **rooms** |
| Large or long results with flow control | **Stream replies** |
| Who is connected, and what they may call | Handshake **auth** and **policies** (rbac) |
| Payloads checked before a handler runs | **Validation** (ajv, as in `@spinajs/http`) |
| One error shape everywhere, mapped from spinajs exceptions | **Error mapping** |
| Survive drops, restarts and overload without losing or repeating work | **Resilience**: reconnect, durable idempotent commands, ordering, limits, graceful shutdown |

The editor server (sync, ops, snapshots) is the first user. Any other spinajs app can use the layer as it is.

## 2. Today

`@spinajs/http-socket` v2.0.548 has:

- a `WebsocketServer` (socket.io 4.8) that is not `@Injectable`, with a protected `Server`;
- `SocketServerMiddleware` with `before`, `onConnect` and `onDisconnect`;
- a `SocketController` whose descriptor nothing fills (there are no decorators);
- no rooms or broadcast API, no replies, no error mapping and no tests.

No package in the repo depends on it, so a breaking v3 costs nothing.

## 3. Packages (Spinajs repo)

| Package | Runtime | Contents |
|---|---|---|
| `@spinajs/http-socket-common` (new) | isomorphic, no dependencies | Wire envelopes, error codes, `PROTOCOL_VERSION`, contract typing helpers |
| `@spinajs/http-socket` (v3 rewrite) | Node | Server: controllers and decorators, the command pipeline, `SocketHub` (rooms and push), error mapping, limits, idempotency store, graceful shutdown |
| `@spinajs/http-socket-client` (new) | isomorphic: `socket.io-client` only, no DI | Client: connection state machine, reconnect, commands, durable outbox, events, streams, typed contracts. Subpath `/browser` adds `IndexedDbOutboxStore` |
| `@spinajs/rbac-http-socket` (new) | Node | Handshake authentication from rbac sessions or Bearer tokens (`rbac-http-token`), the `@User()` argument, rbac policies on commands |

**Transport: socket.io 4.8**, as today. It brings reconnection, heartbeats, rooms, binary attachments, acks, adapters
for several server instances, and connection state recovery. The layer's protocol sits on socket.io acks and events.

## 4. Wire protocol

All messages go over socket.io. Payloads are JSON with optional binary parts (`ArrayBuffer` / `Uint8Array` travel as
socket.io attachments).

```ts
// handshake: io(url, { auth })
interface Handshake { protocol: number; clientId: string; token?: string; [key: string]: unknown }
// a refused handshake rejects with connect_error data: SocketError (unauthenticated | version_mismatch)

// command: client → server event 'cmd', answered through the socket.io ack
interface CommandRequest { id: string; name: string; payload: unknown; idempotencyKey?: string; deadline?: number; traceparent?: string }
type CommandReply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: true; stream: true }                 // the result comes as stream frames
  | { id: string; ok: false; error: SocketError }

interface SocketError {
  code: ErrorCode
  message: string
  details?: unknown                                        // validation errors, conflicting keys, …
  retryable: boolean
  retryAfterMs?: number
  errorId?: string                                         // matches the server log line
}
type ErrorCode =
  | 'invalid_argument' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'failed_precondition'
  | 'unimplemented' | 'deadline_exceeded' | 'cancelled' | 'resource_exhausted' | 'unavailable' | 'version_mismatch' | 'internal'

// event: either direction, 'evt'
interface EventFrame { name: string; payload: unknown }

// stream reply: server → client 'chunk' | 'end' | 'fail'; client → server 'credit' | 'cancel'
interface Chunk { id: string; seq: number; data: unknown }
```

## 5. Server

### 5.1 Controllers

The decorators mirror `@spinajs/http`:

```ts
@SocketController('docs')                         // command and event names get the prefix: 'docs.open'
@Policy(LoggedPolicy)                             // http policy groups: AND inside a group, OR across groups
export class DocsSocket extends BaseSocketController {
  @Command('open', { schema: OpenSchema, timeoutMs: 10_000 })
  async open(@Payload() req: OpenDto, @Connection() conn: SocketConnection, @User() user: User): Promise<OpenResult> { … }

  @Command('submit', { idempotent: true, ordered: 'connection' })
  async submit(@Payload() op: OpDto, @Signal() signal: AbortSignal): Promise<Ack> { … }

  @Command('snapshot')
  async *snapshot(@Payload() req: SnapshotRequest): AsyncIterable<SnapshotChunk> { … }   // a stream reply

  @OnEvent('cursor')                              // fire-and-forget from the client
  async cursor(@Payload() at: Cursor, @Connection() conn: SocketConnection): Promise<void> { … }

  @OnConnect()    async joined(@Connection() conn: SocketConnection): Promise<void> { … }
  @OnDisconnect() async left(@Connection() conn: SocketConnection, @Reason() reason: string): Promise<void> { … }
}
```

The argument decorators are `@Payload()` (validated against the command `schema` or the DTO's `@Schema`, and
hydrated as http args are), `@Connection()`, `@User()` (rbac-http-socket), `@Signal()`, `@Reason()` and `@FromDI()`.

### 5.2 The command pipeline

Each command goes through these stages in order. The first one that fails replies with its error.

1. **Size:** over `maxPayloadBytes` → `resource_exhausted`.
2. **Rate:** a token bucket per connection → `resource_exhausted`, with `retryAfterMs`.
3. **In flight:** more than `maxInFlightPerConnection` → `resource_exhausted`.
4. **Lookup:** an unknown name → `unimplemented`.
5. **Idempotency** (`idempotent: true` with an `idempotencyKey`): a completed key replays the stored reply; a running
   key awaits the same promise. The handler never runs twice for one `(clientId, key)`.
6. **Policies** → `unauthenticated` / `forbidden`.
7. **Arguments:** extraction and ajv validation → `invalid_argument`, with `details`.
8. **Ordering** (`ordered: 'connection' | 'client'`): the command waits in a serial queue per connection, or per
   `clientId` across reconnects.
9. **The handler runs** with an `AbortSignal` that fires on the deadline (`deadline_exceeded`), a client `cancel`
   (`cancelled`), a disconnect, or shutdown (`unavailable`).
10. **Reply:** the result, a stream, or a mapped error.

### 5.3 Error mapping

`@HandleSocketException(ExceptionType)` registers a mapper. Lookup walks the prototype chain, as `@spinajs/http`'s
`__resolve_error_response__` does, so a domain subclass of `Forbidden` maps as `forbidden`.

| Exception (`@spinajs/exceptions`) | Code | Retryable |
|---|---|---|
| `InvalidArgument`, `BadRequest`, `JsonValidationFailed` | `invalid_argument` | no |
| `AuthenticationFailed` | `unauthenticated` | no |
| `Forbidden` | `forbidden` | no |
| `ResourceNotFound` | `not_found` | no |
| `ResourceDuplicated` | `conflict` | no |
| `InvalidOperation` | `failed_precondition` | no |
| `NotSupported`, `MethodNotImplemented` | `unimplemented` | no |
| deadline / cancel | `deadline_exceeded` / `cancelled` | yes / no |
| limits / shutdown | `resource_exhausted` / `unavailable` | yes |
| anything else | `internal` | no |

For `internal`, the message is hidden in production. An `errorId` is logged and returned instead, as the http error
handler does. A throw in an event handler or a connect hook is logged and never takes the socket down.

### 5.4 Push and rooms: `SocketHub`

`SocketHub` is injectable. Its API:

- `to(room).emit(name, payload)` and `toConnection(id).emit(name, payload)`
- `join(connectionId, room)` and `leave(connectionId, room)`
- `connectionsIn(room)`
- `disconnect(connectionId, reason)`

A `SocketConnection` carries `id`, `clientId`, `user`, `rooms`, a typed `data` bag and its own `emit`. Joining or
leaving a room is a server-side decision: clients ask through ordinary commands.

### 5.5 Resilience (server)

- **Heartbeats:** socket.io ping, configurable.
- **Connection state recovery:** on by default, for 2 minutes. A short drop keeps the connection's rooms, and the
  events it missed are replayed.
- **`IdempotencyStore`:** pluggable. The default is an in-memory LRU with a TTL (10 minutes); ORM and Redis stores can
  plug in. Durable client commands rely on it.
- **Graceful shutdown**, on app dispose:
  1. stop accepting connections;
  2. emit `sys.shutdown {retryAfterMs}`;
  3. let running commands finish for up to `drainMs` (5 s);
  4. abort the rest with `unavailable`;
  5. close.
- **Several instances:** a socket.io adapter set by config (`http.socket.adapter`). The default is in memory; others
  need sticky sessions or the adapter. This is documented, not built.
- **Observability:** a debug log line per command (name, duration, code), metrics hooks through
  `@spinajs/telemetry` (count, latency, errors by code), and `traceparent` carried into the handler's context.

### 5.6 Configuration (`http.socket`)

`path`, `cors`, `pingInterval`/`pingTimeout`, `recovery.maxDisconnectionMs`, `maxPayloadBytes` (1 MB),
`maxInFlightPerConnection` (32), `rate` `{perSecond, burst}`, `idempotency` `{service, ttlMs}`, `drainMs`, `adapter`.

## 6. Client (`@spinajs/http-socket-client`)

```ts
const client = new SocketClient({
  url, path,
  auth: async () => ({ token: await tokens.current() }),  // asked on every (re)connect
  clientId,                                                 // stable per install; the app persists it
  reconnect: { minMs: 500, maxMs: 30_000, jitter: 0.3 },
  defaultTimeoutMs: 15_000,
  outbox: new IndexedDbOutboxStore('editor'),               // turns on durable commands; MemoryOutboxStore by default
})

client.state                                                 // 'connecting' | 'online' | 'offline' | 'closed'
client.on('state', (state) => …)
await client.command<OpenResult>('docs.open', req, { timeoutMs, signal, whenOffline: 'fail' })   // or 'wait'
await client.durable<Ack>('docs.submit', op)                 // persisted, ordered, retried
for await (const chunk of client.stream<SnapshotChunk>('docs.snapshot', req)) { … }
client.on('docs.committed', (payload) => …)                  // server events
client.on('failed', ({ entry, error }) => …)                 // a durable command refused for good
```

- **Typed contracts.** `defineContract<{ commands: { 'docs.open': [OpenDto, OpenResult], … }, events: { … } }>()`
  returns a `TypedSocketClient` with checked names and payloads. One contract module is shared by the server and the
  client.
- **Reconnect.** Exponential backoff with jitter. Auth is asked again on each attempt. `unauthenticated` stops the
  retries and emits `auth_required`. `version_mismatch` stops and emits `incompatible`. `sys.shutdown` waits
  `retryAfterMs` before the next attempt.
- **Plain commands.** When offline, `whenOffline: 'fail'` (the default) rejects at once with `unavailable`; `'wait'`
  holds the command in memory until the client is online or the timeout passes. A drop in the middle of a command
  rejects it with `unavailable`, which is retryable.
- **Durable commands.**
  1. A command is written to the `OutboxStore` before it is sent, with `idempotencyKey = clientId:seq`.
  2. Commands go out in order, pipelined up to a window (default 16). The server must declare the command
     `idempotent` and `ordered: 'client'`.
  3. After any drop, everything not acked is resent in order. The server's idempotency store makes the resend safe.
  4. On `ok`, the entry is removed. On a retryable error, it is retried with backoff. On a non-retryable error, it
     moves to the store's `failed` list and `failed` is emitted. The entry is never dropped silently.
  5. The store survives reloads (IndexedDB), so a closed tab resumes its queue on the next start.
- **Streams.** Credit-based flow control. The client grants credits (default 8 chunks) and grants more as the consumer
  reads. Breaking out of the `for await` sends `cancel`, and the server generator's `finally` runs.
- **Stores.** `MemoryOutboxStore`, `IndexedDbOutboxStore` (`/browser`, tested with `fake-indexeddb`) and
  `FileOutboxStore` (Node, for services that call other services).

## 7. Testing

Tests use mocha, chai and sinon, as the rest of the repo does. They run a real server on a random port. A small fault
kit can:

- kill the engine connection;
- delay or drop acks;
- restart the server on the same port.

| Area | Must show |
|---|---|
| Errors | Every row of §5.3 maps as listed; validation `details` arrive; `internal` hides its message in production |
| Auth | A missing or invalid token is refused at the handshake; `forbidden` comes from a policy; `version_mismatch` |
| Cancellation | Deadline, client cancel and disconnect each fire the handler's `AbortSignal` |
| Idempotency | A replay of a finished key returns the stored reply; concurrent replays run the handler once |
| Ordering | `ordered: 'client'` runs a client's commands in send order across a reconnect |
| Durable | 1 000 commands with the connection killed at random 100 times: each runs **exactly once** on the server, and all resolve in order on the client |
| Durable + reload | A client with an IndexedDB store, recreated mid-queue, finishes the queue |
| Streams | A slow consumer never has more chunks in flight than its credit; `cancel` runs the generator's `finally` |
| Shutdown | Running commands finish, new ones get `unavailable`, and the client reconnects to the restarted server and drains its durable queue |
| Limits | Size, rate and in-flight limits answer `resource_exhausted` with `retryAfterMs` |
| Rooms | `to(room).emit` reaches exactly the joined connections; recovery replays events missed in a 5 s drop |

## 8. Plans (Spinajs repo, each with its own implementation plan)

| Plan | Scope |
|---|---|
| **W1 Server core** | `http-socket-common`; `http-socket` v3: controllers, decorators, command pipeline steps 1–4 and 6–10 (all but idempotency), error mapping, `SocketHub`, handshake auth hook, limits, config |
| **W2 Client core** | `http-socket-client`: state machine, reconnect, plain commands, events, typed contracts |
| **W3 Resilience** | `IdempotencyStore`, ordered commands, durable commands with the memory, IndexedDB and file stores, graceful shutdown, recovery settings, the fault kit |
| **W4 Streams, rbac, docs** | Stream replies with credits; `rbac-http-socket`; README and an example app |

W1 and W2 can run in parallel once `http-socket-common` exists. W3 needs both. W4 needs W1 and W2.

## 9. Owner answers (2026-10-02)

1. **socket.io stays** as the transport.
2. **The breaking `http-socket` v3 is approved.**
3. **Package names approved:** `http-socket-common`, `http-socket-client`, `rbac-http-socket`.
