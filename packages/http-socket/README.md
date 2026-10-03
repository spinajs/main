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

By default, `SocketServer` attaches socket.io to the http server of `@spinajs/http` (`HttpServerHost`). Resolve it after `HttpServer`, before or after `start()`:

```ts
import { DI } from '@spinajs/di';
import { HttpServer } from '@spinajs/http';
import { SocketServer } from '@spinajs/http-socket';

const http = await DI.resolve(HttpServer);
await DI.resolve(SocketServer);
await http.start();
```

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
7. **Policies.** `@SocketPolicy` / `@SocketAccess` answer `unauthenticated` or `forbidden`.
8. **Arguments.** Extraction and ajv validation answer `invalid_argument`, with the validation errors in `details`.
9. **Ordering.** `ordered: 'connection' | 'client'` waits in a serial queue. A stream handler cannot be `ordered`.
10. **Handler.** It runs with an `AbortSignal`.

Order 500, between lookup and policies, is reserved for idempotency. A stage of your own is a DI class:

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

`audit` stands for your own code.

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
  - The client's request carries `credits`, its window (the client's default is 8). The server asks the generator for the next item only while it holds credit, so a slow consumer slows the producer and nothing piles up in memory. The client grants more as it reads.
  - Finding the end of a stream needs one credit in hand, but does not spend it.
- **Stopping.**
  - A client `cancel` (a `break` out of `for await`), a disconnect, shutdown, a stall and a refused grant abort the handler's signal and run the generator's `finally`.
  - A stream that gets no credit for `streams.stallTimeoutMs` (60 s) fails with `deadline_exceeded`.
  - A generator that throws ends the stream with `fail`, after the chunks it already sent.
  - Nothing else bounds a stream source. It must honour `@Signal()`: a source that ignores its signal keeps running, and keeps its stream slot, until it settles by itself.
- **Context.** Every step runs inside the call's AsyncLocalStorage store, so `AuthzService.current()` and the log context are the connection's.
- **Limits:**
  - `credits` above `streams.maxCredits` (64) fails with `invalid_argument` and `details { limit }`. The limit applies to the request, to each later grant, and to the credit that is granted but not yet used.
  - More than `streams.maxPerConnection` (8) open streams on a connection answers `resource_exhausted` with `retryAfterMs: 100`. A stream holds its slot until its source has settled.
  - An open stream holds no `maxInFlightPerConnection` slot.
- **Ordering.** A stream handler cannot be `ordered`: the server refuses to start with it, because its queue place would be released when the generator is returned, long before the stream ends. An `ordered` handler that returns some other async iterable is answered `failed_precondition`.
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
- **No credentials.** A connection without credentials runs as `UNATTENDED`, so authz denies it and scoped ORM queries fail closed. `http.socket.auth.required: true` refuses such handshakes instead.
- **Origins.** A handshake from a browser page on another origin is refused with `forbidden` unless that origin is listed exactly in `http.socket.cors.origins` (empty by default).
- **Revalidation.** Live connections re-check their principal every `http.socket.auth.revalidateMs` (60 s), and `ceiling.expiresAt` is always enforced. A revoked credential gets `unauthenticated`, and the server closes the connection with `sys.disconnect { reason: 'unauthenticated' }`.

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
| `streams.maxCredits` | `64` | largest credit window per stream |
| `streams.maxPerConnection` | `8` | open streams per connection |
| `streams.stallTimeoutMs` | `60_000` | a stream without credit this long fails |
| `transports` | `['websocket', 'polling']` | engine.io transports; prefer `['websocket']` with cookie authentication |
| `adapter` | `undefined` | socket.io adapter for several instances |

`system.dirs.socketControllers` (default `[]`) lists the folders scanned for socket controllers. An invalid limit stops the server at startup with a `RangeError`; `RELEASE_NOTES.md` lists the checks.

## Observability

- **Debug lines.** One per command (`socket command <name> <code> <ms>ms connection <id>`) and one per stream (`socket stream <name> <outcome> <n> chunks <ms>ms connection <id>`).
- **Metrics** (through `@spinajs/telemetry`): `socket_commands_total{command, code}`, `socket_command_duration_seconds{command}`, `socket_connections` and `socket_streams_total{command, code}`. Only registered command names become labels.
- **Tracing.** An inbound `traceparent` is carried into the handler's log context.

## Several instances

Set `http.socket.adapter` to a socket.io adapter (for example Redis) so rooms and pushes reach every instance, and use sticky sessions with the polling transport. Ordering queues, open streams and the closing filter of the principal guard are per instance.

## More

`RELEASE_NOTES.md` has the full behaviour notes: revalidation rules, startup checks, connection state recovery and the list of removed v2 APIs.
