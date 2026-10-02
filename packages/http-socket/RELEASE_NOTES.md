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

Socket controllers live in `system.dirs.socketControllers`, never in `system.dirs.controllers`.

### Authentication and authorization (authz-v3)

- A connection without credentials runs as `UNATTENDED`: authz denies it, and scoped ORM queries fail closed. Set `http.socket.auth.required: true` to refuse such handshakes instead.
- Bearer tokens (`auth.token` or `Authorization`), keys and signatures resolve through `@spinajs/authn` (`AuthnCredentialSource`). Cookies are never a socket credential.
- Every command, event and hook runs with the principal in the AsyncLocalStorage store under `Principal`, so `AuthzService.current()` works in socket handlers.
- `@SocketAccess(permission, { resource, also, domain, allowAnonymous })` is the socket form of `@Access`. The legacy rbac policies (`LoggedPolicy`, `RbacPolicy`, `TokenPolicy`) are not supported on sockets.
- `http.socket.cors.origins` (default `[]`) admits cross-origin pages. An empty list refuses every cross-origin handshake with `forbidden`.
- Live connections re-check their principal every `http.socket.auth.revalidateMs` (60 s), and at once when `ceiling.expiresAt` passes. Invalid credentials answer `unauthenticated` and close the connection. See "Revalidation" below for the tri-state contract.

### New: `@spinajs/http-socket-common`

This package holds the wire protocol (`PROTOCOL_VERSION` 1, envelopes, the 13 error codes, `SocketException`, `defineContract`). It is shared by the server and `@spinajs/http-socket-client`.

### Revalidation

- `SocketPrincipalSource.revalidate()` is tri-state: `'valid' | 'invalid' | 'unavailable'` (booleans are still accepted). A throw or a timeout from a source now means `'unavailable'`: the connection is kept for one grace window (`revalidateMs`) and closed if the next check is still unavailable. It no longer closes immediately.
- A server-wide sweep re-checks idle connections, so a revoked or expired credential stops receiving pushes without a command. Each check times out at `min(revalidateMs, 10 s)` and then counts as `'unavailable'`. A command and the sweep share one check per connection.

### Configuration

- New `http.socket.transports` (default `['websocket', 'polling']`): the engine.io transports. Prefer `['websocket']` when a principal source reads cookies.
- New `http.socket.maxInFlightEventsPerConnection` (default `128`). It must be at least `rate.burst`. Events have their own in-flight cap, separate from `maxInFlightPerConnection`.
- New `http.socket.ordering.abortGraceMs` (default `30_000`): how long an aborted `ordered` command whose handler is still running keeps its queue place.
- `http.socket.hooks.connectTimeoutMs` (default `10_000`): a connect hook still running after it is logged and commands stop waiting for it, so a disconnect hook may start while the connect hook is still running.
- Limit refusals read "more than N commands in flight on this connection" and "more than N events in flight on this connection".

### Handshake and names

- Origin rules: a cross-origin handshake is refused unless its origin is listed in `http.socket.cors.origins`. `Origin: null` (sandboxed frames, `file:`) is refused. JSONP polling (`j=` parameter) and no-Origin requests marked `Sec-Fetch-Site: cross-site|same-site` are refused. An https page may reach a plain-http server on the same host:port (a TLS-terminating proxy that keeps `Host`); the reverse never.
- A handler whose command or event name fails `NAME_PATTERN` or `MAX_NAME_LENGTH` (128) is refused at startup. Incoming names are checked with the same rule.
- `@spinajs/http-socket-common` now exports `isName`, `NAME_PATTERN` and `MAX_NAME_LENGTH`.

### SocketHub

- `to([])` and empty room names throw (socket.io would treat an empty set as every socket).
- Names starting with `sys.` are reserved for server notices; pushing one throws.
- Pushes skip connections that are being closed, on the local instance only. Pushes by room or connection id still reach other instances through a configured socket.io adapter; `connection()` sees only local connections.
- Public additions: `ISocketEmitter`, the `socket_*` metrics helpers (`socketMetrics`, `observeCommand`, `trackConnection`), `SocketPrincipalGuard`.

## Notes for W3 (resilience)

- `sys.shutdown` must be sent through `SocketConnection.notify()` or a raw `io.emit`. `SocketHub` pushes refuse `sys.*` names.
- Idempotency must key independently of the running map: the dispatcher's per-connection running map is by request id and is not a dedupe store.
