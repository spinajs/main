# Release notes — WebSocket server core (W1)

> Branch `feat/websocket-layer`, built on `feat/authz-v3`. Design: `docs/superpowers/specs/2026-10-02-spinajs-websocket-design.md`. Merged into the root `RELEASE_NOTES.md` for 3.0.0-rc.1.

## BREAKING CHANGES

### `@spinajs/http-socket` — v3 rewrite

The v2 API is gone. No package in the repo used it.

| Removed (v2) | Use instead |
|---|---|
| `WebsocketServer` | `SocketServer`. It is `@Injectable`: resolve it after `HttpServer` and before `start()`, so the authz boot checks see its controllers (B02). Resolved after `start()`, it still serves sockets. |
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
- A `SocketPrincipalSource` that yields a system or unattended principal refuses the handshake as `internal`, as authz-http refuses such a `PrincipalSource`.
- Bearer tokens (`auth.token` or `Authorization`), keys and signatures resolve through `@spinajs/authn` (`AuthnCredentialSource`). Cookies are a socket credential only through the opt-in `SessionSocketPrincipalSource` of `@spinajs/authn-http/socket` (order 40); the origin guard refuses cross-site handshakes before any source runs.
- Every command, event and hook runs with the principal in the AsyncLocalStorage store under `Principal`, so `AuthzService.current()` works in socket handlers.
- `@SocketAccess(permission, { resource, also, domain, allowAnonymous, subject, fields, unfilteredInput })` is the socket form of `@Access`. The legacy rbac policies (`LoggedPolicy`, `RbacPolicy`, `TokenPolicy`) are not supported on sockets.
- `http.socket.cors.origins` (default `[]`) admits cross-origin pages. An empty list refuses every cross-origin handshake with `forbidden`.
- `ArgInputFilter`s ( `AuthzInputFieldFilter` included ) run on `@Payload` arguments of commands, events and streams, and their refusals answer `invalid_argument` with the http `error` code and `fields` in `details`. The parameter is named `payload`: a list of anything but records, or a record payload declared with a primitive type, is checked as one field named `payload`. A primitive payload (string, number, boolean) skips the input filters, because it has no field names: use a record payload for anything the decision restricts.

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

### authz-v3 follow-ups (G3–G6)

- `ISocketHandshake.address` is now the client address through trusted proxies: the socket's peer, or, when that peer is a trusted proxy hop (`authn.http.trustProxy`, else `http.trustProxy`, the rule of authn-http's `ClientIp`), the `X-Forwarded-For` entry the trusted hops vouch for. Without either setting it is the peer (SR-03), now normalized (trimmed, IPv4-mapped to IPv4) as every address is. The raw peer is the new required `ISocketHandshake.peerAddress: string`; a handshake built by hand (tests, custom transports) must set both. `SocketServer` refuses to start with a malformed trust entry (`InvalidOption` naming the key).
- `ISocketAccess` has a required `scope: 'handler' | 'class'`, which `@SocketAccess` sets. `ISocketAccessOptions` gains `subject`, `unfilteredInput` and `fields?: 'filter' | 'none'`; `AccessFieldsStage` runs at order 650.
- A `@SocketAccess` resource extractor that returns `null` or `undefined` answers `invalid_argument` "the resource extractor of <command> found no resource". It used to fall back to the type-level resource.
- When a handler and its controller both carry `@SocketAccess`, only the handler's decision is left in `storage.AuthzDecision`, as authz-http keeps only the route's own. Before, the last policy to finish won.
- `@SocketAccess` permissions now feed authz's boot rule 7 (`SocketAccessContributor`): an unregistered permission fails the boot of the domain it checks in (B02). A domain checks only the socket controllers registered when it boots, and authz-http boots the root domain when the http server starts listening, so resolve `SocketServer` before `http.start()`. Resolved later, it warns about the rules a booted domain missed; their unregistered permissions are found only at run time (`UnknownPermission`, answered `internal`).
- `@SocketAccess` is declared once per place: a second one on the same handler or class throws when the module loads. On a subclass it replaces the inherited rule of that place; before, the inherited rule stayed as another policy group, an alternative (OR) that could widen access.
- `SocketPrincipalSource.revalidate(handshake, principal, check?: ISocketRevalidation)`, with `ISocketRevalidation { trigger: 'sweep' | 'recovery' | 'command' | 'event'; active: boolean }`. `SocketPrincipalGuard.ensure(connection, trigger)` takes the trigger, and its protected `check` / `revalidate` / `ask` signatures changed (matters to subclasses). `ISocketAuthState.activeAt?: number` records the last client activity.
- `@spinajs/authn-http/socket` exports `SessionSocketPrincipalSource`, `Authenticated`, `MfaSatisfied`, `NoImpersonationPolicy`, `NoTokenAuthPolicy` and `NotLoggedPolicy`. `@spinajs/authn-session` adds `DefaultSessionIssuer.peek` and `peekingSessions`.

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

### authz-v3 follow-ups (G3–G6)

- **Input filters (G3).** Socket payloads pass through http's `ArgInputFilter`s, as an http body does. With `@spinajs/authz-http` loaded, its `AuthzInputFieldFilter` strips, or in `reject` mode refuses, the payload fields outside `decision.fields.write` and the domain's `fields.neverRead`, using the decision `@SocketAccess` left in the call store (B17). A command without `@SocketAccess` is not filtered; `unfilteredInput: reason` opts one out.
- **Error details.** An error that carries the stable code http puts in its body (own prop `error`) or the refused `fields` answers them in `details`, for every `codeMapping` mapping and `InvalidArgumentMapping`: `forbidden { error: 'session_required' }`, `invalid_argument { error: 'fields_not_writable', fields: ['owner'] }`.
- **`@SocketAccess` on authz-http's rules (G4).** `subject: 'load'` checks a conditional allow again against the row the domain's `ResourceAdapter` loads; a missing row is denied with `unknown_resource`. `fields: 'filter'` limits a result, or each stream chunk, to `decision.fields.read` minus `fields.neverRead` (`AccessFieldsStage`, order `STAGE_ORDER.Policies + 50`); only a top-level binary result or chunk passes unchanged. The policy writes authz-http's `AuthzHttpRoute` mark, so a call another policy group admitted still loses `fields.neverRead`; without a decision, the mark and `fields: 'filter'` use the handler rule's domain, else the class rule's, as authz-http's `routeDomain`. `socketAccessOf(groups)` returns the `@SocketAccess` rule of one scope. Denials never carry a trace: sockets offer no explain.
- **Session cookie (G6).** `import '@spinajs/authn-http/socket'` registers `SessionSocketPrincipalSource`. It restores the signed session cookie of authn-http (raw and `s:` forms, `http.cookie.secret`) and resolves it with authn-http's `SessionPrincipalResolver`, so impersonation, banned identities and `ActiveRole` (`ceiling.roles`) behave as in http. A pending (pre-MFA) session is no principal (SR-07). Revalidation restores the session again: logout, revocation or an id rotation (login, role switch, impersonation) closes the socket, and the client reconnects with its new cookie. Revalidation sweeps of an idle connection peek the session and never extend it; a check after a client command or event (a sweep included), a handshake and a recovery slide its expiry (`maxLifetime` still ends it).
- **authn-http policies (G5).** `Authenticated`, `NotLoggedPolicy`, `NoTokenAuthPolicy`, `NoImpersonationPolicy` and `MfaSatisfied` (the 3.0 classes, re-exported by `@spinajs/authn-http/socket`) work as `@SocketPolicy`. `NoSession`, `FreshAuth` and `PendingMfaEnrolment` need `AuthnSession`, which sockets do not have; they are not exported from `/socket`.

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
- `http.socket.idempotency` (default `{ service: 'MemoryIdempotencyStore', ttlMs: 600_000, maxEntries: 100_000 }`), `http.socket.drainMs` (`5_000`) and `http.socket.shutdownRetryAfterMs` (`5_000`): see W3 resilience.
- Limit refusals read "more than N commands in flight on this connection" and "more than N events in flight on this connection".

### SocketHub

- Pushes skip connections that are being closed, on the local instance only. Pushes by room or connection id still reach other instances through a configured socket.io adapter; `connection()` sees only local connections.
- Public additions: `ISocketEmitter`, the `socket_*` metrics helpers (`socketMetrics`, `observeCommand`, `trackConnection`), `SocketPrincipalGuard`.

## Startup checks

`SOCKET_CONFIGURATION_SCHEMA` checks `http.socket` when the configuration loads. A bad value fails the boot with `InvalidConfiguration`, which names the full path of every bad key (`http.socket.rate.burst`), when:

- `rate.perSecond` or `rate.burst` is not a positive number;
- `maxInFlightEventsPerConnection` is not an integer of at least `rate.burst`;
- `maxPayloadBytes` is not a finite integer above 0;
- `maxInFlightPerConnection` is not an integer above 0;
- `auth.required` is not `true` or `false`;
- `auth.revalidateMs` is not a finite number of at least 0;
- `drainMs` is not a finite number of at least 0;
- `transports` is empty, repeats a transport, or holds anything but `'websocket'` and `'polling'`;
- `hooks.connectTimeoutMs` or `ordering.abortGraceMs` is not a number within (0, 2^31-1];
- `path` is empty, or `pingInterval` or `pingTimeout` is not an integer within 1 and 2^31-1;
- `recovery.maxDisconnectionMs` is not a finite number of at least 0;
- `streams.maxCredits` or `streams.maxPerConnection` is not an integer above 0;
- `streams.stallTimeoutMs` is not an integer within 1 and 2^31-1;
- `rate`, `auth.revalidateMs`, `hooks`, `ordering`, `streams` or another required key is missing.

The configuration coerces types, as everywhere in spinajs: a numeric string is read as its number. `NaN` and `Infinity` are refused. `auth.required` takes only `true` or `false`. `null` and booleans are refused for `auth.revalidateMs`, `drainMs`, `recovery.maxDisconnectionMs`, `hooks.connectTimeoutMs`, `ordering.abortGraceMs`, `pingInterval` and `pingTimeout`, where coercion would read `null` and `false` as 0, which turns revalidation, the drain or recovery off, and `true` as 1 ms.

`SocketServer` itself refuses to start with a `RangeError` for a bad `idempotency`, `shutdownRetryAfterMs` or a `drainMs` above 2^31-1, and warns when the drain may outlast `http.shutdownTimeout`; see W3 resilience (startup checks).

The handler registry refuses to start with `InvalidOperation` when a command or event name is invalid (`NAME_PATTERN`, `MAX_NAME_LENGTH`), when a name is declared twice, when a method carries socket parameter or policy decorators but no `@Command`, `@OnEvent`, `@OnConnect` or `@OnDisconnect`, and when an `ordered` or `idempotent` command's handler is an async generator (W4): its queue place would be released when the generator is returned, long before the stream ends, and its reply is never stored. An `ordered` or `idempotent` handler that returns another async iterable is answered `failed_precondition` at run time, only after the handler ran: its side effects have happened, and its idempotency key is released. Socket.io is not attached in either case.

## Behaviour notes

- **Rate limit.** Every `cmd` frame takes a token from the connection's bucket when it arrives, including frames without an ack, malformed frames and duplicate ids. A refused frame without an ack is dropped silently. Ack-less frames are logged with one warn per connection per 10 s, the rest at debug.
- **Ordering.** `ordered: 'client'` queues are keyed by the principal (`principalKey`) and the `clientId`, so another principal sending the same `clientId` never waits on that queue.
- **Shutdown.** `dispose()` runs `SocketServer.shutdown()`, which the host's `http.server.closing` DI event also starts. The steps:
  1. Refuse new handshakes, recovered sockets and new commands with a retryable `unavailable` carrying `retryAfterMs = http.socket.shutdownRetryAfterMs`. New events are dropped.
  2. Send `sys.shutdown { retryAfterMs }` to every local connection.
  3. Let running commands and open streams finish for up to `drainMs`.
  4. Answer the rest with `unavailable`, and wait for those replies to be written.
  5. Disconnect the local sockets, and wait up to `drainMs` for the disconnect hooks while the hub can still push. Then close.

  Set `http.shutdownTimeout` above `http.socket.drainMs` + 3 s, or the http server destroys the sockets mid-drain; startup warns about it. See W3, Graceful shutdown.
- **Connection state recovery.** A recovered connection keeps its socket id, and `SocketConnection.recovered` is `true`.
  - Its disconnect hooks ran at the drop. Its connect hooks run again on recovery and can read `conn.recovered`, for example to skip re-joining rooms, which recovery restores. Commands and events wait for the hooks, which wait for the re-check below.
  - A recovered connection whose principal has a source is re-checked with that source before its hooks and commands run, whatever `auth.revalidateMs` says. An `'invalid'` answer closes it with `sys.disconnect { reason: 'unauthenticated' }`. An `'unavailable'` answer runs the hooks and keeps the connection for one grace window. A `'valid'` answer that carries a principal replaces the restored one; that is how a session restored through a serializing adapter gets its `Principal.identity` back. A source that answers plain `true` keeps the flattened one.
  - A stored session is restored, with its missed pushes, only while its principal is unexpired, not due for revalidation, and not revoked (closed by the principal guard). Otherwise the client gets a full handshake and a new id, without the missed pushes.
  - The restore filter wraps socket.io 4.8 internals (`adapter.restoreSession`, `Namespace._initAdapter`). `test/recovery.test.ts` must pass before any socket.io upgrade.

## W3 resilience (breaking changes)

- **`STAGE_ORDER` changed.** `Idempotency` is new at `500`, and `Ordering` moves from `800` to `550`: after idempotency, before policies (`600`) and arguments (`700`). Policies and hydrators of an `ordered` command now run inside its queue place, so they see what the commands before it changed. A durable edit pipelined right behind its create is no longer hydrated before the create ran (its `not_found` would be stored as final). `ordered` commands without `after` get the same, stronger ordering. A custom stage with an `Order` between `550` and `800` now runs inside the queue place.
- **`isCommandRequest` is stricter.** `idempotencyKey` and the new `after` must be 1 to `MAX_KEY_LENGTH` (256) printable ASCII characters (`isKey`). A frame that breaks this is refused as a malformed command (`invalid_argument`).
- **`idempotencyKey` / `after` rules.**
  - An `idempotencyKey` on a command that is not `idempotent` is refused with `failed_precondition`.
  - An `after` without an `idempotencyKey` is refused with `invalid_argument`.
  - An `after` on an `idempotent` command that is not `ordered: 'client'` gets the fence check alone, without a queue place: it runs only once its predecessor has completed, so `durable()` works on it at any queue position.
- **An `outbox` requires an explicit `clientId`.** `new SocketClient({ outbox })` without `clientId` throws a `RangeError` for any `outbox`, an explicit `MemoryOutboxStore` included; only the default store (no `outbox` option) works without one. Persisted keys start with `${clientId}:`, and a fresh random id after a reload would break exactly-once and ordering.
- **Streams cannot be idempotent or ordered.** An async-generator handler declared `idempotent` or `ordered` is refused at startup. Another async iterable returned by such a command is answered `failed_precondition`, but only after the handler ran: its side effects have happened, and its key is released, so a resend runs it again. A stream reply is never stored.
- **Unauthenticated outcomes are released, not stored.** An `unauthenticated` error releases the idempotency key, so the command runs after a re-login. A retryable error and the call's own abort release it too.
- **A fire-and-forget `durable()` rejects.** Its promise rejects when the server refuses the command for good (it is then in the `failed` list) and when the client closes before the server answered it (the entry stays in the outbox). A caller that does not await it attaches a `catch`, or follows `acked` / `failed` instead; otherwise the rejection is unhandled.
- **`dispose()` drains**, up to `drainMs` (5 s by default) plus the flush windows described under Shutdown. Tests that close servers with handlers still running can set `http.socket.drainMs: 0`.
- **The lifecycle events `acked`, `failed` and `held`** are routed to the client's own listeners. A server event with one of these names no longer reaches `client.on()`.

## W3 resilience (new)

### Idempotent commands (pipeline stage `IdempotencyStage`, `Order` 500)

- `@Command(name, { idempotent: true })` plus a request `idempotencyKey`: a completed key replays its stored reply, and a running key is joined. The handler never runs twice for one `(principalKey, clientId, idempotencyKey)`; the three parts are `encodeURIComponent`-encoded in the store key.
- A result and a non-retryable error are stored. A replayed error keeps its `errorId`. A result JSON cannot represent (a BigInt, a cycle) throws while it is converted for the store: the call is answered `internal` and the key is released, so a resend runs the handler again. A value JSON drops (a function) is answered, and stored, as `undefined`.
- A retryable error, an `unauthenticated` error, the call's own abort (deadline, cancel, disconnect, shutdown while queued) and a stream result release the key.
- A key stays running until its handler settles, even after the client got an abort reply, and even for a handler the ordering stage cut loose after `ordering.abortGraceMs`. A resend joins it and never runs it twice.
- `IdempotencyStore` is pluggable through `http.socket.idempotency.service` (a class name; the whole `http.socket.idempotency` object is its constructor argument). The default `MemoryIdempotencyStore` keeps up to `maxEntries` (100 000) completed keys for `ttlMs` (10 min), least recently used first out.
- A store shared by several instances must make `claim` atomic and expire the running claims of a dead instance. While another instance runs a key, this one answers a retryable `unavailable` with `retryAfterMs: 1000`.
- Public API: `IdempotencyStore`, `MemoryIdempotencyStore`, `SocketIdempotency`, `IdempotencyStage`, `ISocketIdempotencyClaim`.

### Ordering and the `after` fence

- `CommandRequest.after` names the idempotency key of the durable command sent before. The ordering stage (`Order` 550) runs the command only once the store holds that key as completed. Otherwise it answers a retryable `unavailable` with `details: { after }`, which lets the durable client requeue the command without pausing its queue.
- The outcome of an ordered command is stored before its queue place is released, so the next command's fence sees it.

### Durable commands (`@spinajs/http-socket-client`)

- `client.durable(name, payload, { key? })` writes the command to the outbox before it sends it. The key is the app's `key` (1 to 256 printable ASCII characters, not starting with `${clientId}:`) or a generated `${clientId}:<random nonce>` that is persisted with the entry. The queue:
  - sends up to `durable.window` (16) commands at once, each `after` the previous unacknowledged one, with no deadline;
  - resends everything unacknowledged after any drop, and a command unanswered for `durable.ackTimeoutMs` (60 s) on a live connection;
  - retries retryable errors with the reconnect backoff, honouring `retryAfterMs`, and sends only its head while it probes;
  - keeps an `unauthenticated` command queued, emits `held` once, and sends nothing until the connection comes online again;
  - moves a command refused for good to the store's `failed` list and emits `failed`;
  - emits `acked` for each acknowledged command, also for those resumed from the outbox after a reload.
- Callers and the `acked` / `failed` listeners hear about commands in send order. `close()` rejects the callers still waiting for an answer with a non-retryable `unavailable`; their entries stay in the store. A command the server already answered settles with that answer once the store has applied it, also after `close()`: the store write may land after the close, and the next start would then not find the entry. `close()` returns a promise that resolves once the store has no write of the client in flight and every answered command has been reported; await it before opening the next client or store on the same outbox, and keep the `acked` / `failed` listeners until then.
- `durable.maxPayloadBytes` (1 MiB) is checked before the command is persisted.
- Stores, all passing one contract suite (`add` durable before the send, a `seq` that is never reused, a `failed` list kept until `clearFailed`):
  - `MemoryOutboxStore`, the default; it does not survive a reload;
  - `IndexedDbOutboxStore(name, { factory?, exclusive? })` from `@spinajs/http-socket-client/browser`; with the global IndexedDB it refuses a second live store on the same name through `navigator.locks`;
  - `FileOutboxStore(path)` from `@spinajs/http-socket-client/node`; one JSON file written through a temp file, fsync and rename, one process per file. Its `add` rejects with a `TypeError`, writing nothing, a payload a JSON round trip would change (binary, `Date`, `Map`, class instances, non-finite numbers, `undefined` in an array): after a restart the command would be sent with different bytes. `undefined` properties are allowed, as the wire drops them too.

### Graceful shutdown

- `SocketServer.shutdown()` is idempotent. `dispose()` awaits it, and the host's own HttpServer starts it with `http.server.closing`; a closing event of another http server is ignored.
- During the drain, new handshakes, recovered connections and new commands are refused with `unavailable` and `retryAfterMs = http.socket.shutdownRetryAfterMs` (new, default `5_000`). A recovered connection gets `sys.shutdown` before its refusal. New events are dropped.
- Every local connection gets `sys.shutdown {retryAfterMs}` through `SocketConnection.notify()`. Running commands, open streams and their stage chains get up to `drainMs` to finish. After that, the rest are answered `unavailable`, and open streams get `fail unavailable`, except keyed commands whose handler already started: they get 1 s more to answer, and record, their real outcome.
- The server then disconnects only its own clients (`io.local`), waits up to 1 s for the transports to write the last replies and frames and up to `drainMs` for the disconnect hooks (which can still push), and closes. An adapter whose `close()` does not settle within 1 s is not waited for.
- Startup warns when `drainMs + 3 000` reaches `http.shutdownTimeout`, after which `@spinajs/http` destroys the connections.

### Recovery

`SocketConnection.recovered`, and the principal re-check of recovered connections; see the Connection state recovery behaviour note.

## W3 resilience (startup checks)

`SocketServer` also refuses to start with a `RangeError` when:

- `idempotency.service` is not a non-empty string, `idempotency.ttlMs` is not within (0, 2^31-1], or `idempotency.maxEntries` is not an integer above 0;
- `drainMs` is above 2^31-1 (the configuration schema refuses a negative one), or `shutdownRetryAfterMs` is not a finite number above 0.

It warns when `drainMs + 3 000` reaches `http.shutdownTimeout`. `SocketClient` throws a `RangeError` for a `durable.window` or `durable.maxPayloadBytes` that is not an integer of at least 1, and for an invalid `durable.ackTimeoutMs`. `durable()` rejects with a `RangeError` for a key that `isKey` refuses or that starts with `${clientId}:`.

## W3 resilience (spec amendments)

- Spec §6 step 1 and plan D7 said `idempotencyKey = clientId:seq`. The key is now `clientId:<random nonce>`, persisted with the entry. A store that starts over (wiped, or in memory) reuses `seq`s, and the server would replay an old command's stored reply to a new one.

## W3 resilience (known limits)

- No idempotency store has a lease yet: a handler that never settles keeps its key running forever, and every resend of it waits or is refused. A shared store (Redis, ORM) needs to expire running claims.
- A reply the store could not keep is still answered and its key released. A double run therefore needs both a store failure and a lost ack.
- Exactly-once needs a keyed handler that rolls back when its signal aborts, for every abort reason (disconnect, cancel, deadline, shutdown), or that never throws the abort after it has committed. A handler that commits and then throws the abort reason (or another retryable error) releases its key, so a resend runs it again. Only the shutdown deadline marks the outcome as unknown and keeps the key. Check the signal before committing, and make the commit the last step.
- Exactly-once across a graceful restart also needs a shared idempotency store, and handlers that finish within `drainMs` + `SHUTDOWN_FLUSH_MS` (1 s) or roll back when their signal aborts. A keyed handler still running after that is answered `unavailable` and its key stays running, because it may have committed. With a shared store, its resends are refused until the store expires the claims of the dead instance. With the memory store, the key dies with the process, and a resend to the next instance runs the command again. The memory store does not give exactly-once after a crash either. The editor's opId dedupe is the backstop.
- A completed key is forgotten after `ttlMs`. An unacknowledged entry resent after a longer offline period runs again.
- A principal switch mid-queue changes the key scope: an anonymous command whose ack was lost runs again after login.
- Unauthenticated connections share one principal key, so their idempotency keys and `after` fences are scoped by `clientId` only.
- Pushes reach a recovered connection until its re-check answers, capped at `min(revalidateMs, 10 s)`. Its commands and events wait for the re-check.
- A plain `'valid'` (or `true`) answer from a custom `revalidate()` keeps the identity flattened by a serializing adapter. Only an answer that carries the principal restores it. The default `revalidate()` carries it.
- Polling clients do not drain. `@spinajs/http` stops listening before it emits `http.server.closing`, so a polling client gets `sys.shutdown` and then loses its transport at its next poll. The replies of its running commands are lost, though a keyed command's outcome is still recorded for the resend. WebSocket clients drain fully. Draining them needs the http server to stop listening only after the socket drain (a follow-up in `@spinajs/http`).
- Stream backpressure reads engine.io's `conn.writeBuffer`, a private field.
- A stream command cannot be `idempotent`, cannot take `after`, and cannot be a fence predecessor: its reply is never stored.
- The `after` fence and the `ordered: 'client'` queues are per instance; several instances need sticky sessions.

## W3 resilience (follow-ups)

Deferred from the W3 review. Each item is a ticket of its own.

- **`@spinajs/http` emits `http.server.closing` before it stops listening.** Today the http server stops listening and only then emits the event, so a polling client loses its transport at its next poll and the replies of its running commands are lost. Emitting first, and closing the listener after the socket drain settles (bounded by `http.shutdownTimeout`), lets polling clients drain like WebSocket ones. The change belongs in `@spinajs/http`; `SocketServer.shutdown()` already runs on the event.
- **A lease on running idempotency claims.** `IdempotencyStore.claim` holds a running key until its handler settles, with no expiry. A handler that never settles, or a server instance that dies mid-run, keeps the key running forever, and every resend waits or is refused `unavailable`. Add a lease (claim time plus a configurable duration, renewed while the handler runs) that the store expires, and test it on the memory store before any shared store (Redis, ORM) ships.
- **Idempotency byte budget, per-principal quota and metrics.** `MemoryIdempotencyStore` caps completed keys by count (`maxEntries`), not by the size of their stored replies, and one principal can fill it and evict everyone else's keys before their TTL. Add a byte budget over stored replies, a per-principal key quota, and metrics for replays, joins, fence refusals and evictions before TTL, so an operator can see when exactly-once is being weakened.
- **Join dedupe for ack-timeout resends.** An ack timeout sends a durable command again while the first request stays outstanding (`DurableQueue.onAckTimeout`). On the server the resend joins the running key (`SocketIdempotency.begin`) and pins another in-flight slot until the run ends, so a slow handler with repeated ack timeouts consumes `maxInFlightPerConnection`. Collapse joins of the same key on one connection to one waiter, or answer the older request with a superseded reply, and stop counting joined resends against the in-flight limit.
- **Key fingerprint mismatch answers `failed_precondition`.** A completed key replays its stored reply whatever the new request's name or payload. A client bug that reuses a key for a different command silently gets the wrong reply. Store a fingerprint of name and payload with the claim and answer a mismatching request `failed_precondition` instead of replaying.
- **An inter-process lock file for `FileOutboxStore`.** One process per file is documented, not enforced; two processes on the same file overwrite each other's queue on every commit. Take an exclusive lock file (O_EXCL create with the owner's pid, stale-lock detection) when the store first loads, and refuse a second owner with a clear error, as `IndexedDbOutboxStore` does through `navigator.locks`.
- **The ordering cut-loose path closes a late stream result.** When `OrderingStage` cuts a hanging ordered handler loose after `ordering.abortGraceMs`, a non-generator async iterable it returns later is dropped without its `return()` being called, so its resources (cursors, subscriptions) leak. Close it, as `SocketDispatcher.closeStream` does for a stream that will never be sent.
- **An optional per-command `streamIdleMs`.** `streams.stallTimeoutMs` ends a stream that gets no credit, but a generator that holds credit and yields nothing keeps its slot forever. Add an optional `@Command(name, { streamIdleMs })` that fails a stream with `deadline_exceeded` when no chunk is produced for that long.
- **Stream backpressure on a private engine.io field.** Backpressure reads `conn.writeBuffer`, which engine.io does not export. Recheck it on every socket.io / engine.io upgrade (a test that fails when the field disappears), and replace it with a public signal if engine.io gains one.
- **Detect non-generator iterables before side effects.** An `idempotent` or `ordered` handler that returns a non-generator async iterable is refused `failed_precondition` only after it ran: its side effects happened and its key is released, so a resend runs it again. Detect it before the handler runs, for example from a declared return type in the contract or a `stream: true` command option checked at startup, so such a command is refused before it has any effect.

## authz-v3 G3–G6 (known limits)

- `subject: 'load'` answers `unknown_resource` for a missing row and `no_access` for an existing row the caller may not read, as authz-http does, so a caller with a conditional allow can tell which ids exist. Owner ruling 2026-10-08: fixed in both packages together (see the follow-ups).
- A custom `SessionIssuer` that is not a `DefaultSessionIssuer` ignores `peekingSessions`, so revalidation sweeps of idle connections still slide its sessions. Idle timeouts must exceed `revalidateMs`: a slide lands at the next check.
- `allowAnonymous` and `unfilteredInput` apply only to the `@SocketAccess` rule that carries them. authz-http's `@AllowAnonymous` and `@UnfilteredInput` on a class cover every route; on a socket, a handler with its own rule still refuses an anonymous caller and still filters its payload unless that rule sets the option too.
- A primitive payload (string, number, boolean) skips the input filters, while http checks a primitive body parameter by its name. Use a record payload for anything the decision restricts.
- A custom resource extractor must return a ref or a loaded row. Sockets have no `fromModel`, and nothing turns an unloaded ORM instance into its ref (authz-http's `AccessPolicy.refOf`), so the engine would read its default field values as the row.
- Socket extractors add no `type` to boot refs, so boot rule 7 cannot catch a type/permission mismatch of a `@SocketAccess` with a `resource` extractor.

## authz-v3 G3–G6 (follow-ups)

Deferred from the G3–G6 review. Each item is a ticket of its own.

- **`details.error` on `@SocketAccess` refusals.** `AccessDeniedMapping` and the `Unauthenticated` that `SocketAccessPolicy` throws carry no `details.error`, while the authn-http policies' refusals do (`session_required` ...), so clients see two shapes. Add `forbidden` / `unauthenticated`, as authz-http's 401 and 403 bodies carry them.
- **A primitive payload through the input filters.** Run the `ArgInputFilter`s on a primitive payload too, so authz-http's filter checks it by its parameter name (`payload`) as http checks a primitive body parameter.
- **The inherited-rule splice belongs in `decorators.ts`.** `SocketAccess` removes the inherited `@SocketAccess` group by mutating the controller descriptor itself (access.ts); move that into a descriptor helper in `decorators.ts`, beside `SocketPolicyGroup`.
- **A `type` on socket extractor refs.** `fromPayload` and other socket extractors declare no resource type, so their boot refs carry none. Tag them through `Symbol.for('authz:access:extractor')`, as authz-http's extractors are, so boot rule 7 checks the type.
- **One trust-proxy precedence.** The `authn.http.trustProxy`, else `http.trustProxy` rule is written twice (http-socket `client-address.ts`, authn-http `client-ip.ts`); move it to `@spinajs/http`.
- **One field-set helper.** `AccessFieldsStage.readable()` repeats the read half of authz-http's `decisionFields`; share one helper through `@spinajs/authz`.
- **`peek` on the `SessionIssuer` contract.** A custom `SessionIssuer` ignores `peekingSessions`, so its sweeps slide sessions. Put `peek` on the contract and let the socket session source call it; that also removes the hazard of two `peekingSessions` AsyncLocalStorage copies when the ESM and CJS builds of authn-session both load.
- **One answer for a missing and a forbidden row (owner ruling 2026-10-08).** `subject: 'load'` answers `unknown_resource` for a missing row and `no_access` for an existing row the caller may not read, in authz-http (`AccessPolicy`) and here (`SocketAccessPolicy`). Answer both with the same public reason, in both packages in one change, so a conditional allow no longer tells which ids exist.
- **Release blocker: versions.** `@spinajs/http-socket` is at `2.0.549` while `@spinajs/http-socket-client` and `@spinajs/http-socket-common` are at `3.0.0-alpha.0`, and authn-http's `peerDependencies` pin `@spinajs/http-socket` to exactly `2.0.549`. Align them before release.
