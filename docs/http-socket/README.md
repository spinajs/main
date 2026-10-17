# `@spinajs/http-socket`

The WebSocket server of a SpinaJS app, on socket.io 4.8. You write socket controllers with request/response commands, fire-and-forget events and stream replies; the package routes them through a pipeline of limits, authentication, idempotency, ordering, policies and validation, and answers every failure in one error shape.

It does **not** ship a client: use `@spinajs/http-socket-client` (browser and Node). Both speak the protocol of `@spinajs/http-socket-common`, which this package re-exports. It does **not** read session cookies by itself: `import '@spinajs/authn-http/socket'` adds that principal source.

## Install

```sh
npm install @spinajs/http-socket
```

## Features

| Feature | What it does |
| --- | --- |
| [Socket server and HTTP host](01-socket-server.md) | `SocketServer` attaches socket.io to an http server; `SocketHttpHost` picks which one |
| [Socket controllers](02-controllers.md) | `@SocketController`, `@Command`, `@OnEvent`, `@OnConnect`, `@OnDisconnect`; the handler registry |
| [Handler arguments](03-handler-arguments.md) | `@Payload` validation and hydration, `@Connection`, `@Signal`, `@Reason`, `@FromDI`, custom `SocketArg` extractors |
| [Command pipeline and custom stages](04-command-pipeline.md) | The ordered `SocketCommandStage` chain every command passes; adding, replacing and wrapping stages |
| [Error mapping](05-error-mapping.md) | Exceptions to the wire `SocketError`; `@HandleSocketException`, `SocketErrorMapper` |
| [Stream replies](06-stream-replies.md) | Async-iterable results sent as credit-controlled chunk streams |
| [Rooms and server push](07-rooms-and-push.md) | `SocketHub` and `SocketConnection`: rooms, pushes, server-side disconnects |
| [Principal sources and handshake security](08-principal-sources.md) | `SocketPrincipalSource`, `AuthnCredentialSource`, origin checks, client address |
| [Principal revalidation](09-revalidation.md) | `SocketPrincipalGuard`: expiry, revocation sweeps and the `revalidate()` contract |
| [Policies and `@SocketAccess`](10-policies-and-access.md) | http `BasePolicy` classes on sockets, authz-v3 permission checks, field filters, boot checks |
| [Access change push](11-access-change-push.md) | `authz.changed` pushes to the rooms of affected principals |
| [Durable commands: idempotency and ordering](12-durable-commands.md) | `idempotent`, `ordered`, the `after` fence; the pluggable `IdempotencyStore` |
| [Limits](13-limits.md) | Payload size, token-bucket rate, in-flight caps, `TokenBucket`, `payloadSize` |
| [Shutdown and connection recovery](14-shutdown-and-recovery.md) | Graceful drain, `sys.shutdown`, connection state recovery |
| [Configuration](15-configuration.md) | Every `http.socket.*` key, the schema and the startup checks |
| [Observability](16-observability.md) | Debug lines, telemetry metrics, trace context |
| [Running several instances](17-several-instances.md) | socket.io adapters and what stays per instance |

## Quick start

A controller with one command, and a server attached to the `@spinajs/http` server.

```ts sample
import { DI } from '@spinajs/di';
import { HttpServer } from '@spinajs/http';
import { BaseSocketController, Command, Connection, Payload, SocketConnection, SocketController, SocketServer } from '@spinajs/http-socket';

@SocketController('chat')
export class ChatSocket extends BaseSocketController {
  // answers the client command 'chat.join'
  @Command('join', { schema: { type: 'object', required: ['room'], properties: { room: { type: 'string', minLength: 1 } } } })
  public async join(@Payload() req: { room: string }, @Connection() conn: SocketConnection) {
    conn.join(`chat:${req.room}`);
    return { room: req.room, members: conn.rooms.size };
  }
}

export async function start() {
  const http = await DI.resolve(HttpServer);
  await DI.resolve(SocketServer);
  await http.start();
}
```

A runnable server and client are in [`packages/http-socket-example`](../../packages/http-socket-example), explained in [its docs](../http-socket-example/README.md).

## Related packages

- [`@spinajs/http-socket-common`](../http-socket-common/README.md): wire protocol, `SocketException`, `SocketError`, frame guards; re-exported here.
- [`@spinajs/http-socket-client`](../http-socket-client/README.md): the client, with streams and durable commands.
- [`@spinajs/http`](../http/README.md): the default host server, `BasePolicy`, `ArgInputFilter`, `ArgHydrator` and the policy gate sockets reuse.
- [`@spinajs/authz`](../authz/README.md): principals, `AuthzService`, `AccessPushTransport`, boot checks.
- `@spinajs/authn` and `@spinajs/authn-http`: credentials behind `AuthnCredentialSource`, and the session-cookie source (`@spinajs/authn-http/socket`).
- [`@spinajs/di`](../di/README.md): every extension point here is a DI registration.
- [`@spinajs/configuration`](../configuration/README.md): `http.socket.*` and the config-selected `IdempotencyStore`.
