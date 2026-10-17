# Rooms and server push

The server pushes events to clients through `SocketHub` (by room, by connection id, to everyone in a room set) or through one `SocketConnection`. Rooms are a server decision: a client asks to join through an ordinary command, and the handler joins it.

## How it works

1. A handler or service injects `SocketHub` (`@Autoinject()`), or takes the connection with `@Connection()`.
2. `conn.join(room)` or `hub.join(connectionId, room)` adds the connection to a socket.io room.
3. `hub.to(room).emit(name, payload)` checks the room list and the event name, then sends an `evt` frame `{ name, payload }` to every connection in the rooms, except those `SocketPrincipalGuard` is closing.
4. With an adapter configured, room pushes, joins, leaves and disconnects by id reach connections on every instance; `connection()` and `Connections` see only this instance.
5. The client receives the event through `client.on(name, handler)`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SocketHub` | `SocketHub` (self), singleton; attached by `SocketServer.resolve()` | `SocketHub` | Your subclass with app-level addressing helpers | Subclass, add methods or override `push()`; `DI.register(MyHub).as(SocketHub)` before anything resolves `SocketHub`. Or inject `SocketHub` into a service of your own |
| `SocketConnection` | Not in DI: one per socket, built by `SocketServer`; reach it with `@Connection()` or `hub.connection(id)` | `SocketConnection<D, U>` | none | Type `D` (the `data` bag) and `U` (the identity) through its generics |

`SocketHub` API:

| Member | What it does |
| --- | --- |
| `to(room \| rooms).emit(name, payload)` | Every connection in the rooms, on every instance |
| `toLocal(room \| rooms).emit(name, payload)` | The same, on this instance only, even with an adapter |
| `toConnection(id).emit(name, payload)` | One connection; without an adapter, an id this instance does not hold is dropped |
| `join(connectionId, room \| rooms)`, `leave(connectionId, room)` | Join or leave on behalf of a connection |
| `connectionsIn(room)` | Ids of the connections in a room (`Promise<string[]>`) |
| `disconnect(connectionId, reason)` | Sends `sys.disconnect { reason }`, then closes; socket.io does not auto-reconnect after it |
| `connection(id)`, `Connections` | Connections held by this instance |

`SocketConnection` API:

| Member | What it is |
| --- | --- |
| `id`, `clientId`, `protocol` | socket id; the client id and protocol the handshake checked |
| `principal`, `authenticated`, `user`, `auth` | authz-v3 principal (`UNATTENDED` without credentials); whether a source resolved it; `principal.identity`; its source and last check |
| `handshake` | the `ISocketHandshake` the sources saw |
| `data` | app data bag, restored by connection state recovery |
| `rooms`, `connected`, `connectedAt`, `recovered`, `signal` | joined rooms (without its own id); state; the signal aborted when the connection closes |
| `emit(name, payload)`, `join(room)`, `leave(room)`, `disconnect(reason)` | push to this connection; rooms; close with `sys.disconnect { reason }` |

### `SocketHub`: push to a principal on every device

Connections whose principal a source authenticated join `principal:<principalKey>` when they connect (see [Access change push](11-access-change-push.md)). A hub subclass can address that room by principal.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { principalKey } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { ISocketEmitter, SocketHub, principalRoom } from '@spinajs/http-socket';

@Injectable()
export class AppSocketHub extends SocketHub {
  /** Every connection of this principal, on every device and instance. */
  public toPrincipal(principal: Principal): ISocketEmitter {
    return this.to(principalRoom(principalKey(principal)));
  }
}

DI.register(AppSocketHub).as(SocketHub);

export async function notifyExportReady(principal: Principal, exportId: string) {
  const hub = (await DI.resolve(SocketHub)) as AppSocketHub;
  hub.toPrincipal(principal).emit('exports.ready', { exportId });
}
```

## Important behaviour

- A push name must match `NAME_PATTERN` (`[\w.:-]`, at most 128 characters) and must not start with `sys.`, or `emit()` throws `InvalidArgument`. The check runs even when nothing is sent.
- A room list must be non-empty and hold non-empty strings, or `to()` throws `InvalidArgument`: socket.io treats an empty room set as every socket.
- Every hub method but `connection()` and `Connections` throws `InvalidOperation` before `SocketServer` resolved and after it shut down.
- `toLocal()` exists for pushes every instance makes itself, such as one routed from a cluster-wide change bus; `to()` would deliver those once per instance.
- Pushes skip local connections the principal guard is closing, and `SocketConnection.emit()` is a no-op on them.
- The client's own lifecycle names (`state`, `auth_required`, `incompatible`, `refused`, `failed`, `acked`, `held`) shadow server events of the same name.
- Connection state recovery restores rooms and `data` after a short drop; pushes sent during the drop are delivered on recovery.
- `connectionsIn()` and `join()`/`leave()` by id go through the adapter, so they also reach other instances.

## Best practices

- Give server events a dotted prefix (`docs.changed`) so they never collide with client lifecycle names.
- Name rooms by what they hold (`doc:<id>`, `board:<id>`); join them in a command that checks access first.
- Inject `SocketHub` into domain services instead of pushing from controllers, so http routes and jobs can push too.
- Use `toLocal()` only for pushes every instance computes on its own.

## Patterns and antipatterns

```ts
// Don't: let the client name any room it wants to listen to
@OnEvent('listen')
public async listen(@Payload() room: string, @Connection() conn: SocketConnection) {
  conn.join(room);
}

// Do: join in a command that checks access to the resource first
@Command('open')
@SocketAccess('doc:read', { resource: fromPayload('id', 'doc') })
public async open(@Payload() req: { id: string }, @Connection() conn: SocketConnection) {
  conn.join(`doc:${req.id}`);
  return { id: req.id };
}
```

## Examples

### Broadcast a saved comment from a domain service

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { SocketHub } from '@spinajs/http-socket';

export interface Comment {
  id: string;
  docId: string;
  text: string;
}

@Injectable()
export class CommentService {
  @Autoinject()
  protected Hub: SocketHub;

  protected comments: Comment[] = [];

  public async add(comment: Comment): Promise<Comment> {
    this.comments.push(comment);
    // reaches http-triggered and socket-triggered saves alike
    this.Hub.to(`doc:${comment.docId}`).emit('comments.added', comment);
    return comment;
  }

  public async kick(connectionId: string): Promise<void> {
    this.Hub.disconnect(connectionId, 'removed_from_document');
  }
}
```

## Related

- [Access change push](11-access-change-push.md): the per-principal rooms every authenticated connection joins.
- [Running several instances](17-several-instances.md): adapters, and what stays per instance.
- [Principal revalidation](09-revalidation.md): why closing connections receive no pushes.
- [`@spinajs/http-socket-client`](../http-socket-client/README.md): `client.on()` and the lifecycle events.
