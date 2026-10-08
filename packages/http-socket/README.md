# @spinajs/http-socket

WebSocket server for spinajs apps, on socket.io 4.8. It provides:

- socket controllers with request/response commands, fire-and-forget events and stream replies with flow control
- rooms and server push
- authentication through authz-v3 principals, with policies and `@SocketAccess`
- ajv validation of payloads
- one error shape, mapped from spinajs exceptions
- limits and metrics

The client is `@spinajs/http-socket-client` (browser and Node). Both speak the protocol of `@spinajs/http-socket-common`, which this package re-exports.

A runnable server and client are in [`packages/http-socket-example`](../http-socket-example).

## Start the server

By default, `SocketServer` attaches socket.io to the http server of `@spinajs/http` (`HttpServerHost`). Resolve it after `HttpServer` and before `start()`:

```ts
import { DI } from '@spinajs/di';
import { HttpServer } from '@spinajs/http';
import { SocketServer } from '@spinajs/http-socket';

const http = await DI.resolve(HttpServer);
await DI.resolve(SocketServer);
await http.start();
```

Resolved after `start()`, it still serves sockets. With `@spinajs/authz-http`, though, the root authz domain boots when the server starts listening, before `SocketServer` loads its controllers, so the boot checks skip their `@SocketAccess` permissions; `SocketServer` logs a warning naming them (see Authentication and access).

An ES module app must call `DI.setESMModuleSupport()` before it resolves the configuration. Without it the configuration sources look for the CommonJS builds and cannot load them, so the `http.socket` defaults of this package are not loaded.

To attach to another node http(s) server, register your own `SocketHttpHost`:

```ts
import { createServer } from 'node:http';
import { DI } from '@spinajs/di';
import { SocketHttpHost } from '@spinajs/http-socket';

export class PlainHttpHost extends SocketHttpHost {
  public readonly Http = createServer();

  public async server() {
    return this.Http;
  }
}

DI.register(PlainHttpHost).as(SocketHttpHost);
```

Socket controllers are found in the folders listed in `system.dirs.socketControllers`, or by importing their modules. Keep them out of `system.dirs.controllers`, because the http loader scans those.

`SocketServer.dispose()` closes every connection. Running commands and streams end with `unavailable`.

## Controllers

```ts
import { Autoinject } from '@spinajs/di';
import { BaseSocketController, Command, Connection, OnConnect, OnDisconnect, OnEvent, Payload, Reason, Signal, SocketConnection, SocketController, SocketHub } from '@spinajs/http-socket';

@SocketController('docs') // command and event names get the prefix: 'docs.open'
export class DocsSocket extends BaseSocketController {
  @Autoinject()
  protected Hub: SocketHub;

  @Command('open', { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, timeoutMs: 10_000 })
  public async open(@Payload() req: { id: string }, @Connection() conn: SocketConnection) {
    conn.join(`doc:${req.id}`);
    return { id: req.id, user: conn.user ?? null };
  }

  @Command('export')
  public async export(@Payload() req: { id: string }, @Signal() signal: AbortSignal) {
    // the signal fires on the deadline, a client cancel, a disconnect or shutdown
    return renderExport(req.id, signal);
  }

  @OnEvent('cursor')
  public async cursor(@Payload() at: { doc: string; x: number; y: number }, @Connection() conn: SocketConnection) {
    this.Hub.to(`doc:${at.doc}`).emit('docs.cursor', { by: conn.id, at });
  }

  @OnConnect()
  public async joined(@Connection() conn: SocketConnection) {}

  @OnDisconnect()
  public async left(@Connection() conn: SocketConnection, @Reason() reason: string) {}
}
```

`renderExport` stands for your own code.

- **Arguments:**
  - `@Payload(schema?)` is validated against the command `schema`, else the `@Payload` schema, else the DTO's `@Schema`, then hydrated as an http body is.
  - `@Connection()` gives the `SocketConnection`: `id`, `clientId`, `principal`, `user` (the principal's `identity`), `rooms`, `data`, `join`, `leave`, `emit`, `disconnect`.
  - `@Signal()`, `@Reason()` (disconnect hooks) and `@FromDI()` are also available.
- **Principal.** There is no `@User()` decorator; read `conn.user` instead. `AuthzService.current()` is the connection principal inside every handler.
- **Results.** A handler that returns nothing answers `null`. Throw to answer with an error (see Errors).
- **Events.** `@OnEvent` handlers are fire-and-forget. A failing event is logged and dropped.
- **Hooks.** `@OnConnect` / `@OnDisconnect` hooks run no policies. Commands wait until the connect hooks are done, up to `hooks.connectTimeoutMs`.

## The command pipeline

Every command passes these stages in order. The first stage that fails answers with its error.

1. **Size.** Over `maxPayloadBytes` answers `resource_exhausted`, not retryable, with `details { size, limit }`.
2. **Rate.** A token bucket per connection answers `resource_exhausted` with `retryAfterMs`.
3. **In flight.** More than `maxInFlightPerConnection` answers `resource_exhausted` with `retryAfterMs: 100`.
4. **Ready.** The command waits for the connection's connect hooks.
5. **Authentication.** The principal is re-checked (expiry, revalidation); a failure answers `unauthenticated`.
6. **Lookup.** An unknown name answers `unimplemented`.
7. **Idempotency.** An `idempotent` command with an `idempotencyKey` replays the stored reply of a completed run of that key, or waits for a running one.
8. **Ordering.** `ordered: 'connection' | 'client'` waits in a serial queue; `after` requires the named predecessor to have completed, in any mode. A stream handler cannot be `ordered`.
9. **Policies.** `@SocketPolicy` / `@SocketAccess` answer `unauthenticated` or `forbidden`.
10. **Access fields.** `@SocketAccess(…, { fields: 'filter' })` limits the result, or each stream chunk, to the fields the decision lets the caller read.
11. **Arguments.** The `ArgInputFilter`s, then extraction and ajv validation, answer `invalid_argument`, with the validation errors or the refused fields in `details`.
12. **Handler.** It runs with an `AbortSignal`.

Policies and arguments run inside an `ordered` command's queue place, so they see what the commands before it changed. A stage of your own is a DI class:

```ts
import { Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '@spinajs/http-socket';

@Injectable(SocketCommandStage)
export class AuditStage extends SocketCommandStage {
  public get Order() {
    return STAGE_ORDER.Policies + 10;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>) {
    const result = await next();
    audit(ctx.connection.principal, ctx.request.name);
    return result;
  }
}
```

`audit` stands for your own code. For a stream handler, `await next()` returns the handler's async iterable at the stream reply, before the ack and the first chunk, not when the stream ends.

## Errors

Every failure reaches the client as one shape, `{ code, message, retryable, retryAfterMs?, details?, errorId? }`.

| Thrown (`@spinajs/exceptions`, `@spinajs/authz`) | Code | Retryable |
|---|---|---|
| `InvalidArgument`, `BadRequest`, `JsonValidationFailed`, `ValidationFailed` | `invalid_argument` | no |
| `AuthenticationFailed`, `Unauthenticated` | `unauthenticated` | no |
| `Forbidden`, `AccessDenied` | `forbidden` | no |
| `ResourceNotFound` | `not_found` | no |
| `ResourceDuplicated` | `conflict` | no |
| `InvalidOperation` | `failed_precondition` | no |
| `NotSupported`, `MethodNotImplemented` | `unimplemented` | no |
| deadline / client cancel | `deadline_exceeded` / `cancelled` | yes / no |
| rate and in-flight limits / shutdown | `resource_exhausted` / `unavailable` | yes |
| size limit | `resource_exhausted` | no |
| `SocketException(code, message, options)` | its code | its flag |
| anything else | `internal` | no |

Lookup walks the prototype chain, so a domain subclass of `Forbidden` answers `forbidden`. In production an `internal` error hides its message; the `errorId` it returns matches the server log line. To map an exception of your own:

```ts
import { HandleSocketException, SocketError, SocketErrorMapping } from '@spinajs/http-socket';

@HandleSocketException(QuotaExceeded)
export class QuotaExceededMapping extends SocketErrorMapping {
  public map(error: Error): SocketError {
    return { code: 'resource_exhausted', message: error.message, retryable: true, retryAfterMs: 60_000 };
  }
}
```

`QuotaExceeded` is your own exception class.

## Stream replies

A command whose handler returns an async iterable answers with a stream:

```ts
@Command('snapshot')
public async *snapshot(@Payload() req: { docId: string; fromChunk?: number }, @Signal() signal: AbortSignal) {
  const doc = await this.Docs.load(req.docId);
  yield { kind: 'begin', chunks: doc.chunks.length };
  for (let index = req.fromChunk ?? 0; index < doc.chunks.length && !signal.aborted; index++) {
    yield { kind: 'chunk', index, data: doc.chunks[index] };
  }
}
```

`this.Docs` is a service of your own, injected with `@Autoinject()`.

- **On the wire.** The ack is `{ id, ok: true, stream: true }`. Then come `chunk { id, seq, data }` frames numbered from 0, and finally `end { id, seq }` (`seq` = the number of chunks) or `fail { id, error }`. An `undefined` item is sent as `null`. Binary parts (`Uint8Array`, `ArrayBuffer`, `Buffer`) travel as socket.io attachments.
- **Flow control.**
  - The client's request carries `credits`, its window (the client's default is 8). The server asks the generator for the next item only while it holds credit, so a slow consumer slows the producer. The client grants more as it reads.
  - Credit is the client's word, not proof that it reads. The server also pauses a stream while the connection's engine.io write buffer holds more than `streams.maxCredits` unsent packets, and resumes when the buffer flushes to the transport. A connection's unsent frames therefore stay near `maxCredits`, plus one chunk per open stream, plus the batch the transport is writing.
  - Finding the end of a stream needs one credit in hand, but does not spend it.
- **Stopping.**
  - A client `cancel` (a `break` out of `for await`), a disconnect, shutdown, a stall and a refused grant abort the handler's signal and run the generator's `finally`.
  - A stream that gets no credit, or whose connection stays backlogged, for `streams.stallTimeoutMs` (60 s) fails with `deadline_exceeded`.
  - A generator that throws ends the stream with `fail`, after the chunks it already sent.
  - Nothing else bounds a stream source. It must honour `@Signal()`: a source that ignores its signal keeps running, and keeps its stream slot, until it settles by itself.
- **Context.** Every step runs inside the call's AsyncLocalStorage store, so `AuthzService.current()` and the log context are the connection's.
- **Limits:**
  - `credits` above `streams.maxCredits` (64) fails with `invalid_argument` and `details { limit }`. The limit applies to the request, to each later grant, and to the credit that is granted but not yet used.
  - More than `streams.maxPerConnection` (8) open streams on a connection answers `resource_exhausted` with `retryAfterMs: 100`. A stream holds its slot until its source has settled.
  - An open stream holds no `maxInFlightPerConnection` slot.
- **Ordering.** A stream handler cannot be `ordered`: the server refuses to start with it, because its queue place would be released when the generator is returned, long before the stream ends. An `ordered` handler that returns some other async iterable is answered `failed_precondition`.
- **Idempotency.** A stream handler cannot be `idempotent` either, since a stream reply is never stored: an async generator is refused at startup and any other async iterable is answered `failed_precondition`. A stream command cannot take `after` and is never a fence predecessor.
- **Timeouts.** `deadline` and `@Command({ timeoutMs })` bound the time until the stream reply only.
- **Plain calls.** A stream command called with `client.command()` (no `credits`) answers `failed_precondition`, and its generator never starts.
- **Resume.** A dropped connection ends the stream on both sides. To resume, put the position in the payload (`fromChunk` above), and let the client restart from the first chunk it has not applied. `loadSnapshot` in [`packages/http-socket-example/src/client.ts`](../http-socket-example/src/client.ts) is a complete client.

## Rooms and push

`SocketHub` is injectable:

- `to(room | rooms).emit(name, payload)`: every connection in the rooms
- `toConnection(id).emit(name, payload)`
- `join(connectionId, room)`, `leave(connectionId, room)`, `connectionsIn(room)`
- `disconnect(connectionId, reason)`: sends `sys.disconnect { reason }`, then closes
- `connection(id)`, `Connections`: connections on this instance

Rooms are a server decision; clients ask through ordinary commands. Push names must be valid names (`[\w.:-]`, at most 128 characters), and the `sys.` prefix is reserved. Give server events a dotted prefix (`docs.committed`): the client's lifecycle names (`state`, `auth_required`, `incompatible`, `refused`, `failed`) shadow server events of the same name.

## Authentication and access

- **Principal sources.** A handshake is turned into an authz-v3 `Principal` by the registered `SocketPrincipalSource`s, in ascending `order`. The first non-null principal wins, and a throw refuses the handshake with `unauthenticated`.
- **Built-in source.** `AuthnCredentialSource` (order 50) authenticates bearer tokens, keys and signatures through `@spinajs/authn`. The client sends a token as `auth.token`, because browsers cannot set WebSocket headers. Cookies are never read by this source.
- **Session cookie.** `import '@spinajs/authn-http/socket'` registers `SessionSocketPrincipalSource` (order 40). It reads the signed session cookie of `@spinajs/authn-http` (the raw and the `s:` signed form, both verified with `http.cookie.secret`) and resolves the session as http does: an active session wins over bearer credentials, `ActiveRole` becomes `ceiling.roles`, impersonation and banned identities behave as in http, and a pending (pre-MFA) session is no principal. An active session whose principal resolves to null (ban, impersonation ended) refuses the handshake as `unauthenticated` even with `auth.required: false`, which is stricter than http, until the session is removed. Logout, revocation and every session id rotation (login, role switch, impersonation) close the socket at its next revalidation; the client reconnects with the new cookie. Prefer `transports: ['websocket']` with cookies: browsers always send `Origin` on a WebSocket upgrade. Cookie sockets rely on `http.socket.cors.origins` alone: they ignore `authn.http.csrf.allowedOrigins` and `authn.http.csrf.enabled`, and judge same-origin from `Host`, never `X-Forwarded-Host`.
- **Session sliding.** Revalidation sweeps of an idle connection never extend a session; a check after a client command or event (a sweep included), a handshake and a recovery do. Any command or event frame counts (app polling, durable-queue resends, refused or malformed commands); cancel and credit frames do not. A slide lands at the next check, up to `http.socket.auth.revalidateMs` late, so the session idle timeout must exceed `revalidateMs`. A custom `SessionIssuer` that is not a `DefaultSessionIssuer` ignores `peekingSessions`, so its sweeps still slide sessions.
- **No credentials.** A connection without credentials runs as `UNATTENDED`, so authz denies it and scoped ORM queries fail closed. `http.socket.auth.required: true` refuses such handshakes instead.
- **Origins.** A handshake from a browser page on another origin is refused with `forbidden` unless that origin is listed exactly in `http.socket.cors.origins` (empty by default).
- **Revalidation.** Live connections re-check their principal every `http.socket.auth.revalidateMs` (60 s), and `ceiling.expiresAt` is always enforced. A revoked credential gets `unauthenticated`, and the server closes the connection with `sys.disconnect { reason: 'unauthenticated' }`.
- **Behind proxies.** `handshake.address` is the client address: the socket's peer, or behind trusted proxy hops (`authn.http.trustProxy`, else `http.trustProxy`, as authn-http's `ClientIp`) the `X-Forwarded-For` entry they vouch for. `handshake.peerAddress` is the raw TCP peer. Addresses are normalized (trimmed, IPv4-mapped to IPv4) even with no trust setting. Without either setting the address is the peer, whatever `X-Forwarded-For` says. Socket `realIp` and policy `ip` follow this precedence, so they differ from http's `req.storage.realIp` (which uses `http.trustProxy` only) when the two settings differ. A socket-only app that never registers the schema of `@spinajs/authn` validates `authn.http.trustProxy` only through `parseTrustProxy`, which is more lenient than the schema; non-address entries still fail startup.

A source of your own:

```ts
import { Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { ISocketHandshake, SocketPrincipalSource } from '@spinajs/http-socket';

@Injectable(SocketPrincipalSource)
export class ApiKeySource extends SocketPrincipalSource {
  public readonly name = 'api-key';
  public readonly order = 60;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const key = handshake.auth.apiKey;
    return typeof key === 'string' ? lookUpServicePrincipal(key) : null;
  }
}
```

`lookUpServicePrincipal` stands for your own code. `DemoTokenSource` in [`packages/http-socket-example/src/auth.ts`](../http-socket-example/src/auth.ts) is a complete source.

Access checks:

```ts
@SocketController('docs')
@SocketPolicy(SignedInPolicy) // http BasePolicy classes: AND inside one call, OR across calls
export class DocsSocket extends BaseSocketController {
  @Command('read')
  @SocketAccess('docs:read', { resource: fromPayload('id', 'docs') })
  public async read(@Payload() req: { id: string }) {}
}
```

`SignedInPolicy` is a `BasePolicy` of your own. Policies receive an `ISocketPolicyRequest` (`body`, `params`, `storage`, `socketConnection` ...) in place of the express request.

`@SocketAccess` decides as authz-http's `@Access`. Besides `resource`, `also`, `domain` and `allowAnonymous` it takes:

- `subject: 'load'`: a conditional allow is checked again against the row the domain's `ResourceAdapter` loads; a missing row is denied with `unknown_resource`.
- `fields: 'filter'`: the result, or each chunk of a stream reply, keeps only the fields `decision.fields.read` allows, minus the domain's `fields.neverRead`. Only a top-level binary result or chunk passes unchanged; nested binary values are filtered like JSON, as in http. Without `fields: 'filter'` nothing is stripped from output, `neverRead` included, as in http.
- `unfilteredInput: reason`: the payload skips authz-http's input field filter.

`allowAnonymous` and `unfilteredInput` apply only to the rule that carries them. In http, `@AllowAnonymous` and `@UnfilteredInput` on a class cover every route of it. On a socket, a class rule's options do not reach a handler with its own `@SocketAccess`: that handler's rule still refuses an anonymous caller and still filters the payload, unless it sets the option too.

`@SocketAccess` is declared once per place; on a subclass it replaces the inherited rule, as `@Access` does. The handler's own rule decides, else the controller's, and that decision is the one in `storage.AuthzDecision`. A rule decides in its own `domain` (default root), and the input filter and `fields: 'filter'` read the field settings of the decision's domain. A call another policy group admitted has no decision: they read the handler rule's domain, else the class rule's, as http does. A resource extractor that finds nothing answers `invalid_argument`. A custom extractor must return a ref (`{ type, id }`) or a loaded row: sockets have no `fromModel`, and nothing turns an unloaded ORM instance into its ref, so the engine would read its default field values as the row.

Boot checks (B02). `@SocketAccess` permissions take part in the boot checks of the domain they check in, so a permission that domain does not register fails its boot. A domain checks only the socket controllers registered when it boots; a controller registered later is checked by its next boot only. authz-http boots the root domain when the http server starts listening, and `SocketServer.resolve` loads `system.dirs.socketControllers`, so resolve `SocketServer` before `http.start()`. Resolved later, it logs a warning that names the rules a booted domain missed; an unregistered permission among them is found only at run time, where its checks throw `UnknownPermission` (answered `internal`). Socket extractors add no `type` to boot refs (unlike http's), so boot rule 7 cannot catch a type/permission mismatch of a rule with a `resource` extractor.

Input field filters. The `ArgInputFilter`s registered with `@spinajs/http` run on `@Payload` arguments, in commands, events and streams alike. With `@spinajs/authz-http` loaded, a payload loses the fields its decision does not let the caller write; in `reject` mode the command is answered `invalid_argument` with `details { error: 'fields_not_writable', fields }`. A command without `@SocketAccess` is not filtered. The filter parameter is named `payload`: a list of anything but records, or a record payload declared with a primitive type (`@Payload() p: string`), is checked as one field named `payload`, as http checks a primitive body parameter by its name. A primitive payload (string, number, boolean) skips the input filters, because it has no field names: use a record payload for anything the decision restricts.

The 3.0 authn-http policies `Authenticated`, `NotLoggedPolicy`, `NoTokenAuthPolicy`, `NoImpersonationPolicy` and `MfaSatisfied`, exported by `@spinajs/authn-http/socket`, work as `@SocketPolicy`. Their refusals carry the stable code in `details.error` (`session_required`, `already_authenticated`, `impersonating` ...). `NoSession`, `FreshAuth` and `PendingMfaEnrolment` read `AuthnSession`, which socket calls do not carry, so they are not exported from `/socket`; `NoSession` is still importable from the package root and would always pass on a socket: do not attach it with `@SocketPolicy`.

## Configuration (`http.socket`)

| Key | Default | Meaning |
|---|---|---|
| `path` | `'/socket.io'` | socket.io endpoint |
| `cors.origins` | `[]` | other origins allowed to open a socket; exact strings, no wildcards |
| `auth.required` | `false` | refuse handshakes no source resolves |
| `auth.revalidateMs` | `60_000` | principal re-check interval; `0` turns it off (expiry still applies) |
| `pingInterval`, `pingTimeout` | `25_000`, `20_000` | socket.io heartbeats |
| `recovery.maxDisconnectionMs` | `120_000` | connection state recovery window |
| `maxPayloadBytes` | `1048576` | command and event payload limit; binary parts count by byte length |
| `maxInFlightPerConnection` | `32` | commands running at once per connection |
| `maxInFlightEventsPerConnection` | `128` | events waiting or running per connection; at least `rate.burst` |
| `rate` | `{ perSecond: 50, burst: 100 }` | token bucket per connection |
| `ordering.abortGraceMs` | `30_000` | how long an aborted `ordered` command keeps its queue place |
| `hooks.connectTimeoutMs` | `10_000` | how long commands wait for connect hooks |
| `idempotency` | `{ service: 'MemoryIdempotencyStore', ttlMs: 600_000, maxEntries: 100_000 }` | the `IdempotencyStore` class (by name) and how long and how many completed keys it keeps |
| `drainMs` | `5_000` | how long running commands and streams get to finish at shutdown |
| `shutdownRetryAfterMs` | `5_000` | the `retryAfterMs` of `sys.shutdown` and of the `unavailable` refusals during a drain |
| `streams.maxCredits` | `64` | largest credit window per stream |
| `streams.maxPerConnection` | `8` | open streams per connection |
| `streams.stallTimeoutMs` | `60_000` | a stream without credit, or with a backlogged connection, this long fails |
| `transports` | `['websocket', 'polling']` | engine.io transports; prefer `['websocket']` with cookie authentication |
| `adapter` | `undefined` | socket.io adapter for several instances |

`system.dirs.socketControllers` (default `[]`) lists the folders scanned for socket controllers. An invalid value stops the boot: the configuration schema (`SOCKET_CONFIGURATION_SCHEMA`) throws `InvalidConfiguration` with the path of each bad key, and `SocketServer` throws a `RangeError` for a bad `idempotency` or `shutdownRetryAfterMs`, or a `drainMs` above 2^31-1. `RELEASE_NOTES.md` lists the checks.

## Durable commands, shutdown and recovery

**Idempotent and ordered commands.** A command declared `@Command(name, { idempotent: true, ordered: 'client' })` serves `client.durable()`. The request carries an `idempotencyKey` and, for every command but the first in the queue, `after`: the key of its predecessor. Both are 1 to 256 printable ASCII characters.

- A completed key replays its stored reply, and a running key is joined, so the handler runs once per `(principalKey, clientId, key)`. A result and a non-retryable error are stored. A retryable error, `unauthenticated` and the call's own abort release the key.
- The ordering stage (550) runs a command with `after` only once the store holds its predecessor as completed. Otherwise it answers a retryable `unavailable` with `details.after`.
- An `idempotencyKey` on a command that is not `idempotent` answers `failed_precondition`; an `after` without a key answers `invalid_argument`; an `after` on an `idempotent` command that is not `ordered: 'client'` is checked the same way, without a queue place.
- Exactly-once needs a handler that rolls back when its signal aborts, for every abort reason (disconnect, cancel, deadline, shutdown), or that never throws the abort after it has committed. A handler that commits and then throws the abort reason, or another retryable error, releases its key, so a resend runs it again. Only the shutdown deadline marks the outcome as unknown and keeps the key. Check the signal before you commit, and make the commit the last step.
- `MemoryIdempotencyStore` is per process. A store shared by several instances has to make `claim` atomic and expire the running claims of a dead instance; see `IdempotencyStore`.

**Shutdown.** `dispose()` (and the host's `http.server.closing`) refuses new handshakes and commands with `unavailable`, sends `sys.shutdown { retryAfterMs }`, lets running commands and streams finish for `drainMs`, answers the rest with `unavailable`, disconnects the local sockets, waits for the disconnect hooks and closes. Set `http.shutdownTimeout` above `drainMs` + 3 s; startup warns when it is not. Polling clients do not drain, because `@spinajs/http` stops listening before it emits `http.server.closing`.

**Recovery.** A recovered connection has `SocketConnection.recovered === true`, and its connect hooks run again. Its principal is re-checked with its source before the hooks and commands run, whatever `auth.revalidateMs` says.

## Observability

- **Debug lines.** One per command (`socket command <name> <code> <ms>ms connection <id>`) and one per stream (`socket stream <name> <outcome> <n> chunks <ms>ms connection <id>`).
- **Metrics** (through `@spinajs/telemetry`): `socket_commands_total{command, code}`, `socket_command_duration_seconds{command}`, `socket_connections` and `socket_streams_total{command, code}`. Only registered command names become labels.
- **Tracing.** An inbound `traceparent` is carried into the handler's log context.

## Several instances

Set `http.socket.adapter` to a socket.io adapter (for example Redis) so rooms and pushes reach every instance, and use sticky sessions with the polling transport. Ordering queues, open streams and the closing filter of the principal guard are per instance.

## More

`RELEASE_NOTES.md` has the full behaviour notes: revalidation rules, startup checks, connection state recovery and the list of removed v2 APIs.
