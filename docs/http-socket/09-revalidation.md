# Principal revalidation

A socket lives far longer than an http request, so its principal is checked again while it runs. `SocketPrincipalGuard` enforces `ceiling.expiresAt`, asks the principal's source again every `http.socket.auth.revalidateMs`, and closes connections whose credential expired or was revoked.

## How it works

1. `SocketServer.resolve()` calls `SocketPrincipalGuard.start()`. A timer ticks every `min(revalidateMs, 1000)` ms (1 s when revalidation is off).
2. Each tick, `sweep()` walks the local connections a source authenticated:
   1. an expired `principal.ceiling.expiresAt` closes the connection at once;
   2. a connection due for a check (`revalidateMs` since the last valid check, or since the first `'unavailable'` answer) starts one, at most 16 at a time (`MAX_CONCURRENT_REVALIDATIONS`).
3. A command (stage 350) and an event call `ensure(connection, trigger)` first. It refuses an expired or closing connection with `unauthenticated`, and runs a due check before the call, sharing a check the sweep already started.
4. A check calls `source.revalidate(handshake, principal, { trigger, active })` on the source that authenticated the connection, found by `name`. It times out after `min(revalidateMs, 10 s)`.
5. The answer decides:
   - `'valid'`, `true` or `{ status: 'valid', principal }`: `checkedAt` moves on; a carried principal with the same `principalKey` replaces the current one;
   - `'unavailable'`, a throw or a timeout, the first time: the connection keeps running for one more `revalidateMs` grace window and is asked again;
   - `'unavailable'` again, `'invalid'`, `false`, a principal with another `principalKey`, or a source that no longer exists: the connection is closed.
6. Closing marks the connection (no more pushes, no recovery of its session), logs it at info level, and on the next tick of the event loop sends `sys.disconnect { reason: 'unauthenticated' }` and disconnects it. A command refused by the same check is answered `unauthenticated` first.

`ISocketRevalidation` tells the source why it is asked:

| Field | Values | Meaning |
| --- | --- | --- |
| `trigger` | `'sweep'`, `'command'`, `'event'`, `'recovery'` | The server-wide sweep; a client frame that found the check due; connection state recovery |
| `active` | boolean | The client sent a command or event, or reconnected, since the last valid check. Always `true` unless the trigger is `'sweep'` |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.socket.auth.revalidateMs` | number | `60000` | 0 or more; not `null` or a boolean | How often a live connection's principal is re-checked, idle or not; `0` turns re-checks off, `ceiling.expiresAt` is still enforced |

```ts
http: {
  socket: {
    auth: { revalidateMs: 30_000 },
  },
},
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SocketPrincipalSource.revalidate()` | Method of each registered source | Re-runs `authenticate(handshake)`: same `principalKey` is `valid` with the fresh principal; an `AuthenticationFailed` or an unthrottled `unauthenticated` `SocketException` is `invalid`; any other throw is `unavailable` | `AuthnCredentialSource.revalidate()` (throttled or failing `AuthnService` is `unavailable`); `SessionSocketPrincipalSource` (session slides on active checks) | Override it in your source; see [Principal sources](08-principal-sources.md) |
| `SocketPrincipalGuard` | `SocketPrincipalGuard` (self), singleton; injected into `SocketServer`, `SocketHub`, `SocketDispatcher` and `AuthenticationStage` | `SocketPrincipalGuard` | Your subclass | Override the protected `close()`, `expiredAt()`, `dueAt()` or `ask()`; `DI.register(Mine).as(SocketPrincipalGuard)` before anything resolves it |

### `revalidate()`: slide a session only for active clients

A session store usually extends a session on every request. A socket sweep is not a request: slide only when `check.active` is `true`, so an idle tab does not keep a session alive forever.

```ts sample
import { Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { ISocketHandshake, ISocketRevalidation, SocketPrincipalSource, SocketRevalidationResult } from '@spinajs/http-socket';

interface StoredSession {
  userId: string;
  expiresAt: number;
}

const sessions = new Map<string, StoredSession>();
const IDLE_MS = 30 * 60_000;

@Injectable(SocketPrincipalSource)
export class TicketSource extends SocketPrincipalSource {
  public readonly name = 'ticket';
  public readonly order = 30;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const session = this.session(handshake);
    return session ? this.principal(session) : null;
  }

  public async revalidate(handshake: ISocketHandshake, principal: Principal, check?: ISocketRevalidation): Promise<SocketRevalidationResult> {
    const session = this.session(handshake);
    if (!session || session.userId !== principal.id) {
      return 'invalid';
    }

    if (check?.active) {
      session.expiresAt = Date.now() + IDLE_MS;
    }

    // carrying the principal renews its ceiling.expiresAt on the connection
    return { status: 'valid', principal: this.principal(session) };
  }

  protected session(handshake: ISocketHandshake): StoredSession | undefined {
    const ticket = handshake.auth.ticket;
    const session = typeof ticket === 'string' ? sessions.get(ticket) : undefined;
    return session && session.expiresAt > Date.now() ? session : undefined;
  }

  protected principal(session: StoredSession): Principal {
    return Object.freeze({ type: 'user', id: session.userId, authenticated: true, source: this.name, attributes: Object.freeze({}), ceiling: { expiresAt: new Date(session.expiresAt) } });
  }
}
```

### `SocketPrincipalGuard`: tell the client why before closing

`close(connection, why)` runs once per connection the guard gives up on. Push your own notice before calling `super.close()`: afterwards the connection emits nothing but its disconnect notice.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { SocketConnection, SocketPrincipalGuard } from '@spinajs/http-socket';

@Injectable()
export class ExplainingPrincipalGuard extends SocketPrincipalGuard {
  protected close(connection: SocketConnection, why: string): void {
    if (!this.isClosing(connection) && connection.connected) {
      connection.emit('session.ended', { why });
    }
    super.close(connection, why);
  }
}

DI.register(ExplainingPrincipalGuard).as(SocketPrincipalGuard);
```

## Important behaviour

- Connections without a source (`UNATTENDED`) are never re-checked.
- `ceiling.expiresAt` is enforced on every sweep tick and every command or event, whatever `revalidateMs` says. A date that cannot be parsed counts as expired.
- One check per connection runs at a time: the sweep and a command share it.
- The sweep never holds commands back: past 16 running checks it skips the remaining due connections until the next tick, but still checks their expiry.
- During the grace window after an `'unavailable'` answer, commands and events are served.
- A source answering plain `'valid'` or `true` keeps the current principal object. Only an answer that carries the principal replaces it, which is how a renewed token's later `ceiling.expiresAt` reaches the connection.
- A source that renews a principal must keep its identity (`principalKey`): a different key closes the connection, and the per-principal rooms are joined only once.
- Activity is reported at the next check, up to `revalidateMs` after the frame. A session idle timeout must exceed `revalidateMs`.
- Every command or event frame counts as activity, even one refused later; cancel and credit frames do not.
- A recovered connection is re-checked before its hooks and commands run, whatever `revalidateMs` says; see [Shutdown and connection recovery](14-shutdown-and-recovery.md#connection-state-recovery).

## Best practices

- Keep `revalidateMs` well below your credential lifetime, and above the cost of one `revalidate()` call per connection.
- Answer `'unavailable'` for store outages and `'invalid'` only for a definitive refusal; a flapping store then costs no reconnect storm.
- Carry the principal in a `'valid'` answer whenever the source loaded a fresh one.

## Patterns and antipatterns

```ts
// Don't: a store error becomes 'invalid' and drops every connection during an outage
public async revalidate(handshake: ISocketHandshake, principal: Principal) {
  const ok = await this.Store.isActive(principal.id).catch(() => false);
  return ok ? 'valid' : 'invalid';
}

// Do: a store error is 'unavailable', so the connection gets one grace window
public async revalidate(handshake: ISocketHandshake, principal: Principal) {
  try {
    return (await this.Store.isActive(principal.id)) ? 'valid' : 'invalid';
  } catch {
    return 'unavailable';
  }
}
```

## Examples

### Close every socket of a banned user at the next check

```ts sample
import { Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { ISocketHandshake, SocketPrincipalSource, SocketRevalidationResult } from '@spinajs/http-socket';

export const bannedUsers = new Set<string>();

const tokens = new Map<string, string>([['t-alice', 'alice']]);

@Injectable(SocketPrincipalSource)
export class BanAwareTokenSource extends SocketPrincipalSource {
  public readonly name = 'ban-aware-token';
  public readonly order = 20;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const user = typeof handshake.auth.token === 'string' ? tokens.get(handshake.auth.token) : undefined;
    if (!user || bannedUsers.has(user)) {
      return null;
    }
    return Object.freeze({ type: 'user', id: user, authenticated: true, source: this.name, attributes: Object.freeze({}) });
  }

  public async revalidate(_handshake: ISocketHandshake, principal: Principal): Promise<SocketRevalidationResult> {
    return bannedUsers.has(principal.id) ? 'invalid' : 'valid';
  }
}
```

## Related

- [Principal sources and handshake security](08-principal-sources.md): where the principal comes from.
- [Rooms and server push](07-rooms-and-push.md): pushes skip connections the guard is closing.
- [Configuration](15-configuration.md): `http.socket.auth.*`.
