# Release notes — WebSocket server core (W1)

> Branch `feat/websocket-layer`, built on `feat/authz-v3`. Design: `docs/superpowers/specs/2026-10-02-spinajs-websocket-design.md`. X1 merges this file into the root `RELEASE_NOTES.md` for 3.0.

## BREAKING CHANGES

### `@spinajs/http-socket` — v3 rewrite

The v2 API is gone. No package in the repo used it.

| Removed (v2) | Use instead |
|---|---|
| `WebsocketServer` | `SocketServer`. It is `@Injectable`: resolve it after `HttpServer`, either before or after `start()`. |
| `SocketServerMiddleware.before` | `SocketPrincipalSource` (handshake → authz-v3 `Principal`, or a refusal) |
| `SocketServerMiddleware.onConnect` / `onDisconnect` | `@OnConnect()` / `@OnDisconnect()` on a socket controller |
| `SocketController` (abstract class) + `ISocketEvent` | `BaseSocketController` + `@SocketController(prefix)`, `@Command`, `@OnEvent` |
| `SocketMiddleware.execute` | a `SocketCommandStage`, `@SocketPolicy` or `@SocketAccess` |
| `SocketRouteArgs` | `SocketArg` + `@SocketParameter` |
| `ConnectionLogMiddleware` | the per-command debug line and the `socket_*` metrics |

- Socket controllers live in `system.dirs.socketControllers`, never in `system.dirs.controllers`.
- There is no `@User()` parameter decorator. Use `@Connection() conn` and read `conn.user` (the principal's `identity`).
- The package index names its exports. Internal helpers (`parseCookies`, `toHandshake`, `withSlot`, `untilAborted`, the `assert*Config` checks, `SerialQueue`, `policyRequest`, `EVENT_WARN_WINDOW_MS`, `MAX_CONCURRENT_REVALIDATIONS`, ...) are not exported. `SocketHub.attach/detach/register/unregister`, `SocketDispatcher.attach/detach/abortAll` and `SocketPrincipalGuard.start/stop/sweep/release` are `@internal`: only `SocketServer` calls them.

### Authentication and authorization (authz-v3)

- A connection without credentials runs as `UNATTENDED`: authz denies it, and scoped ORM queries fail closed. Set `http.socket.auth.required: true` to refuse such handshakes instead.
- Bearer tokens (`auth.token` or `Authorization`), keys and signatures resolve through `@spinajs/authn` (`AuthnCredentialSource`). Cookies are never a socket credential.
- Every command, event and hook runs with the principal in the AsyncLocalStorage store under `Principal`, so `AuthzService.current()` works in socket handlers.
- `@SocketAccess(permission, { resource, also, domain, allowAnonymous })` is the socket form of `@Access`. The legacy rbac policies (`LoggedPolicy`, `RbacPolicy`, `TokenPolicy`) are not supported on sockets.
- `http.socket.cors.origins` (default `[]`) admits cross-origin pages. An empty list refuses every cross-origin handshake with `forbidden`.

### `SocketPrincipalSource.revalidate()` contract

- It is tri-state: `'valid' | 'invalid' | 'unavailable'` (booleans are still accepted). A `'valid'` answer may carry a renewed principal: `{ status: 'valid', principal }`.
- A throw or a timeout from a source now means `'unavailable'`: the connection is kept for one grace window (`revalidateMs`) and closed if the next check is not `'valid'` either. It no longer closes at once.
- See "Revalidation" under New for the full rules.

### Handshake, ids and names

- `auth.protocol` must be `1` (`version_mismatch` otherwise) and `auth.clientId` must be 1 to 128 characters (`invalid_argument` otherwise). The refusal message echoes the client's protocol only when it is a number.
- Ids must be printable ASCII (0x21-0x7E): a command id outside it is answered `invalid_argument` "malformed command request", a cancel id outside it is dropped, and such a `clientId` refuses the handshake with `invalid_argument`. Ids end up in log lines.
- Origin rules: a cross-origin handshake is refused unless its origin is listed in `http.socket.cors.origins`. `Origin: null` (sandboxed frames, `file:`) is refused. JSONP polling (`j=` parameter) and no-Origin requests marked `Sec-Fetch-Site: cross-site|same-site` are refused. An https page may reach a plain-http server on the same host:port (a TLS-terminating proxy that keeps `Host`); the reverse never.
- A handler whose command or event name fails `NAME_PATTERN` or `MAX_NAME_LENGTH` (128) is refused at startup. Incoming names are checked with the same rule.

### SocketHub

- `to([])` and empty room names throw (socket.io would treat an empty set as every socket).
- Names starting with `sys.` are reserved for server notices; pushing one throws.

## New

### `@spinajs/http-socket-common`

This package holds the wire protocol (`PROTOCOL_VERSION` 1, envelopes, the 13 error codes, `SocketException`, `defineContract`). It is shared by the server and `@spinajs/http-socket-client`. It exports `isName`, `NAME_PATTERN`, `MAX_NAME_LENGTH`, `isId`, `ID_PATTERN` and `MAX_ID_LENGTH`, so a client can check names and ids the way the server does.

### Revalidation

Live connections re-check their principal, so a revoked or expired credential stops receiving pushes even without a command.

- A server-wide sweep ticks every `min(revalidateMs, 1 s)` and re-checks a connection every `http.socket.auth.revalidateMs` (default 60 s). Commands and events check too, before they run. A command and the sweep share one check per connection. At most 16 checks run at once.
- `ceiling.expiresAt` is enforced on every tick and before every command and event. A command of an expired or invalid principal is answered `unauthenticated`; the connection is then closed with `sys.disconnect { reason: 'unauthenticated' }`.
- `revalidateMs: 0` turns revalidation off. The sweep still runs every second and still enforces `ceiling.expiresAt`.
- Each check times out at `min(revalidateMs, 10 s)` (10 s when `revalidateMs` is `0`) and then counts as `'unavailable'`.
- A `{ status: 'valid', principal }` answer whose `principalKey` differs from the connection's counts as `'invalid'` and closes the connection. With the same key, the renewed principal is adopted and its expiry is checked before the command runs.
- The default `revalidate()` re-authenticates the current handshake. It answers `'invalid'` when the source throws `AuthenticationFailed` or an `unauthenticated` `SocketException` without `retryAfterMs`, and `'unavailable'` on any other throw, a throttled refusal included. It answers `'invalid'` when the source returns no principal or a principal with another `principalKey`.
- `UNATTENDED` connections are never re-checked.

### `AuthzService.current()` and `runAs` in socket handlers (G1)

- With the authz-v3 host (F4) merged, `AuthzService.current()` returns the connection principal in commands, events and connect hooks, and `UNATTENDED` for a connection without credentials. The socket layer calls no `runAs` itself.
- A handler's own `runAs(principal, reason, fn)` switches the principal for `fn` only, also while other commands of the same connection run concurrently. It is audited when the domain's `audit.runAs` is enabled. The outer principal is current again after it returns.
- The services of named domains (`AuthzDomains.service(name)`) read the same AsyncLocalStorage store, so their `current()` and `runAs` behave the same in socket handlers.
- `ISocketCallStorage` now extends authz's `IAuthzAsyncStorage`, so `AuthzCache` and `Unscoped` are typed keys of the call store. This is a type-only change; the runtime exports are unchanged.

### Stream replies (W4)

- A command handler that returns an async iterable (an `async *` method) answers with a stream reply. The ack is `{ id, ok: true, stream: true }`. Then come `chunk { id, seq, data }` frames numbered from 0, and finally `end { id, seq }` (`seq` = the number of chunks) or `fail { id, error }`. An `undefined` item is sent as `null`. Binary parts travel as attachments, as in commands.
- Flow control is by credit. The request carries `credits`, the client's window. The server asks the source for the next item only while it holds credit, so a slow consumer slows the producer. Finding the end needs one credit in hand but does not spend it, so the client always keeps one in hand. The client grants more with `credit { id, credits }` as it reads.
- Transport backpressure: credit is not trusted alone. A stream also pauses while its connection's engine.io write buffer holds more than `streams.maxCredits` unsent packets, and resumes when it flushes. The wait counts toward `streams.stallTimeoutMs`, so a client that grants credit but never reads its socket fails with `deadline_exceeded` and frees its slot.
- The stream source is bounded only by credit stall, `cancel`, disconnect and shutdown, and it must honour `@Signal`. `cancel`, a disconnect, shutdown, a stall and a refused grant abort the signal (`cancelled` / `unavailable`) and run the generator's `finally`. A stream that gets no credit for `streams.stallTimeoutMs` fails with `deadline_exceeded`, and the generator's `finally` runs after a stall too.
- Stream handlers cannot be `ordered`: such a handler is refused at startup, and an `ordered` handler that returns another async iterable is answered `failed_precondition`.
- The generator runs inside the call's AsyncLocalStorage store for every item, so `AuthzService.current()` is the connection principal there too.
- A stream command called without `credits` (a plain `client.command()`) is answered `failed_precondition`, and its source never starts. W1 answered stream handlers with `unimplemented`.
- `streams.maxCredits` is enforced on the request, on each grant and on the outstanding (granted but unused) credit after a grant; a breach fails with `invalid_argument` and `details { limit }`. More than `streams.maxPerConnection` open streams on one connection answers `resource_exhausted` with `retryAfterMs: 100`. A stream holds its `maxPerConnection` slot until its source has settled, and no `maxInFlightPerConnection` slot.
- `deadline` and `@Command({ timeoutMs })` bound the time until the stream reply only.
- Streams are never stored: a stage that records results must pass async iterables through (`isStreamResult`, internal).
- An open stream keeps its request id in flight until its `end` or `fail` frame.
- Metrics: `socket_streams_total{command, code}` counts ended streams by outcome (`ok` or the error code). One debug line per stream: `socket stream <name> <outcome> <n> chunks <ms>ms connection <id>`.
- Public additions: `SOCKET_METRIC_KEY_STREAMS`, `observeStream`.

### Configuration

- `http.socket.transports` (default `['websocket', 'polling']`): the engine.io transports. Prefer `['websocket']` when a principal source reads cookies.
- `http.socket.maxInFlightEventsPerConnection` (default `128`). It must be at least `rate.burst`. Events have their own in-flight cap, separate from `maxInFlightPerConnection`.
- `http.socket.ordering.abortGraceMs` (default `30_000`): how long an aborted `ordered` command whose handler is still running keeps its queue place.
- `http.socket.hooks.connectTimeoutMs` (default `10_000`): a connect hook still running after it is logged and commands stop waiting for it, so a disconnect hook may start while the connect hook is still running.
- `http.socket.streams` (default `{ maxCredits: 64, maxPerConnection: 8, stallTimeoutMs: 60_000 }`): the largest window a client may grant one stream, the open streams per connection, and how long a stream may wait for credit or for its backlogged connection to flush.
- Limit refusals read "more than N commands in flight on this connection" and "more than N events in flight on this connection".

### SocketHub

- Pushes skip connections that are being closed, on the local instance only. Pushes by room or connection id still reach other instances through a configured socket.io adapter; `connection()` sees only local connections.
- Public additions: `ISocketEmitter`, the `socket_*` metrics helpers (`socketMetrics`, `observeCommand`, `trackConnection`), `SocketPrincipalGuard`.

## Startup checks

`SocketServer` refuses to start with a `RangeError` when:

- `rate.perSecond` or `rate.burst` is not a positive number;
- `maxInFlightEventsPerConnection` is not an integer of at least `rate.burst`;
- `maxPayloadBytes` is not a finite integer above 0;
- `maxInFlightPerConnection` is not an integer above 0;
- `auth.revalidateMs` is not a finite number of at least 0;
- `transports` is empty or holds anything but `'websocket'` and `'polling'`;
- `hooks.connectTimeoutMs` is not a positive number;
- `ordering.abortGraceMs` is not a positive number;
- `streams.maxCredits` or `streams.maxPerConnection` is not an integer above 0;
- `streams.stallTimeoutMs` is not an integer within 1 and 2^31-1.

The handler registry refuses to start with `InvalidOperation` when a command or event name is invalid (`NAME_PATTERN`, `MAX_NAME_LENGTH`), when a name is declared twice, when a method carries socket parameter or policy decorators but no `@Command`, `@OnEvent`, `@OnConnect` or `@OnDisconnect`, and when an `ordered` or `idempotent` command's handler is an async generator (W4): its queue place would be released when the generator is returned, long before the stream ends, and its reply is never stored. An `ordered` or `idempotent` handler that returns another async iterable is answered `failed_precondition` at run time. Socket.io is not attached in either case.

## Behaviour notes

- **Rate limit.** Every `cmd` frame takes a token from the connection's bucket when it arrives, including frames without an ack, malformed frames and duplicate ids. A refused frame without an ack is dropped silently. Ack-less frames are logged with one warn per connection per 10 s, the rest at debug.
- **Ordering.** `ordered: 'client'` queues are keyed by the principal (`principalKey`) and the `clientId`, so another principal sending the same `clientId` never waits on that queue.
- **Shutdown.** W3 replaces the immediate abort with a graceful drain; see W3, Graceful shutdown.
- **Connection state recovery.** A recovered connection keeps its socket id. Its disconnect hooks ran at the drop, and its connect hooks run again on recovery with the same id. A stored session is restored, with its missed pushes, only while its principal is unexpired, not due for revalidation and not revoked (closed by the principal guard). Otherwise the client gets a full handshake and a new id, without the missed pushes. The restore filter wraps socket.io 4.8 internals (`adapter.restoreSession`, `Namespace._initAdapter`): `test/recovery.test.ts` must pass before any socket.io upgrade.

## Notes for W3 (resilience)

- `sys.shutdown` must be sent through `SocketConnection.notify()` or a raw `io.emit`. `SocketHub` pushes refuse `sys.*` names.
- Idempotency must key independently of the running map: the dispatcher's per-connection running map is by request id and is not a dedupe store.
- Idempotency keys must be `(principalKey, clientId, key)`, for the same reason as the ordering key: a `clientId` is not a secret, and a replayed reply must never reach another principal.

## W3 (resilience)

### Command stage order

- `STAGE_ORDER.Ordering` moves from `800` to `550`, after idempotency (`500`) and before policies (`600`) and arguments (`700`). Policies and hydrators of an `ordered` command now run inside its queue place, so they see what the commands before it changed. A durable edit pipelined right behind its create is no longer hydrated before the create ran (its `not_found` would be stored as final).
- `ordered: 'connection'` and `ordered: 'client'` commands without `after` get the same, stronger ordering. A custom stage ordered between `550` and `800` now runs inside the queue place.

### Graceful shutdown

- `SocketServer.shutdown()` is idempotent. `dispose()` awaits it, and the host's own HttpServer starts it with `http.server.closing`; a closing event of another http server is ignored.
- During the drain, new handshakes, recovered connections and new commands are refused with `unavailable` and `retryAfterMs = http.socket.shutdownRetryAfterMs` (new, default `5_000`). A recovered connection gets `sys.shutdown` before its refusal. New events are dropped.
- Every local connection gets `sys.shutdown {retryAfterMs}` through `SocketConnection.notify()`. Running commands, open streams and their stage chains get up to `drainMs` to finish. After that, the rest are answered `unavailable`, and open streams get `fail unavailable`, except keyed commands whose handler already started: they get 1 s more to answer, and record, their real outcome.
- The server then disconnects only its own clients (`io.local`), waits up to 1 s for the transports to write the last replies and frames and up to `drainMs` for the disconnect hooks (which can still push), and closes. An adapter whose `close()` does not settle within 1 s is not waited for.
- Startup warns when `drainMs + 2 000` reaches `http.shutdownTimeout`, after which `@spinajs/http` destroys the connections.

### Known limits

- No idempotency store has a lease yet: a handler that never settles keeps its key running forever, and every resend of it waits or is refused. A lease belongs to the first shared store (Redis, ORM).
- A reply the store could not keep is still answered and its key released. A second run therefore needs a store failure plus a lost ack.
- A principal switch mid-queue changes the key scope: an anonymous command whose ack was lost runs again after login.
- Unauthenticated connections share one principal key, so their idempotency keys and `after` fences are scoped by `clientId` only.
- The `after` fence and the `ordered: 'client'` queues are per instance; several instances need sticky sessions.
- A stream command cannot be `idempotent` (refused at startup for an async generator, answered `failed_precondition` for another async iterable), cannot take `after`, and is never a fence predecessor: its reply is never stored.
- Exactly-once across a graceful restart needs a shared idempotency store, and handlers that finish within `drainMs` + 1 s or roll back when their signal aborts. A keyed handler still running after that is answered `unavailable` and its key stays running, because it may have committed. With a shared store, its resends are then refused until the store expires the claims of the dead instance. With the memory store, the key dies with the process and a resend to the next instance runs the command again. The editor's opId dedupe is the backstop.
- Polling clients do not drain. `@spinajs/http` stops listening before it emits `http.server.closing`, so a polling client gets `sys.shutdown` and then loses its transport at its next poll. The replies of its running commands are lost, though a keyed command's outcome is still recorded for the resend. WebSocket clients drain fully. Draining polling clients needs the http server to stop listening only after the socket drain.
