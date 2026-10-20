# Running several instances

Behind a load balancer, several server instances share the work. A socket.io adapter lets rooms, pushes, joins and disconnects by id reach connections on every instance; everything else in this package stays per instance.

## How it works

1. Set `http.socket.adapter` to a socket.io adapter (for example the Redis adapter). `SocketServer` passes it to socket.io's `adapter` option.
2. `SocketHub.to()`, `toConnection()`, `join()`, `leave()`, `connectionsIn()` and `disconnect()` go through the adapter, so they reach every instance.
3. `SocketHub.toLocal()`, `connection()` and `Connections` stay on this instance.
4. Shutdown disconnects only this instance's clients (`io.local`) and sends `sys.shutdown` per local connection, so a restart of one instance does not touch the others.
5. With the polling transport, a client's requests must reach the instance that holds its session: use sticky sessions at the load balancer.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.socket.adapter` | adapter | `undefined` (in memory) | a socket.io adapter constructor or factory | Rooms and pushes across instances |
| `http.socket.transports` | string[] | `['websocket', 'polling']` | see [Configuration](15-configuration.md) | `['websocket']` removes the need for sticky sessions |
| `http.socket.idempotency.service` | string | `'MemoryIdempotencyStore'` | a registered store | Use a shared store for exactly-once across instances |
| `authz.bus.service` (`@spinajs/authz`) | string | in-process bus | `'QueueChangeBus'` (`@spinajs/authz-queue`) | Every node sees every access change |

```ts
// app configuration, with @socket.io/redis-adapter and redis installed
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';

const pub = createClient({ url: process.env.REDIS_URL });
const sub = pub.duplicate();
await Promise.all([pub.connect(), sub.connect()]);

export default {
  http: {
    socket: {
      adapter: createAdapter(pub, sub),
      transports: ['websocket'],
      idempotency: { service: 'KvIdempotencyStore', ttlMs: 600_000, maxEntries: 100_000 },
    },
  },
  authz: { bus: { service: 'QueueChangeBus' } },
};
```

What stays per instance:

| State | Effect with several instances |
| --- | --- |
| `ordered` queues and the `after` fence | Ordering holds only while a client stays on one instance |
| `MemoryIdempotencyStore` | A resend that lands on another instance runs the command again; a shared store fixes it |
| Open streams | A stream ends when its instance goes down |
| Rate buckets and in-flight counters | Per connection, so per instance |
| The principal guard's closing filter | Each instance closes its own connections |
| `socket_connections` | Counts this instance |
| Access change pushes | Each node pushes to its own connections (`toLocal()`) |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| socket.io adapter | `http.socket.adapter`, not in DI | in memory | Redis, Postgres, cluster adapters | Set the configuration key |
| `IdempotencyStore` | config-selected | `MemoryIdempotencyStore` | your shared store | See [Durable commands](12-durable-commands.md#idempotencystore-a-store-shared-by-several-instances) |
| `SocketHub.toLocal()` | `SocketHub`, singleton | local push through `io.local` | `to()` for cluster-wide pushes | Use it for pushes every instance computes itself; see [Rooms and server push](07-rooms-and-push.md#sockethub-push-to-a-principal-on-every-device) to extend the hub |

### Fan a cluster-wide message out to local connections

When every instance receives the same message from a shared bus, each one must push only to its own connections; `to()` would deliver it once per instance.

```ts sample
import { EventEmitter } from 'node:events';
import { Autoinject, Injectable } from '@spinajs/di';
import { SocketHub } from '@spinajs/http-socket';

/** Stand-in for a message bus every instance subscribes to ( Redis pub/sub, a queue topic ). */
export const clusterBus = new EventEmitter();

@Injectable()
export class PriceTicker {
  @Autoinject()
  protected Hub: SocketHub;

  public start(): void {
    clusterBus.on('price', (tick: { symbol: string; price: number }) => {
      if (this.Hub.Connections.size > 0) {
        this.Hub.toLocal(`prices:${tick.symbol}`).emit('prices.tick', tick);
      }
    });
  }
}
```

## Important behaviour

- `SocketHub.toConnection(id)` without an adapter drops an id this instance does not hold; with an adapter it is sent as a room.
- `SocketHub.Connections.size` is the local count; `toLocal()` throws while the hub is detached, so check it, or guard the push, before shutdown completes.
- Connection state recovery needs an adapter that supports it; a client that reconnects to another instance gets a full handshake.
- Shutdown closes the adapter (waiting at most 1 s).

## Best practices

- Prefer `transports: ['websocket']` in a cluster: no sticky sessions, and a browser always sends `Origin`.
- Route clients of one user to one instance (sticky by user) when you rely on `ordered: 'client'` or the `after` fence.
- Pair the adapter with a shared idempotency store and `QueueChangeBus`; each fixes a different per-instance gap.

## Patterns and antipatterns

```ts
// Don't: every instance handles the bus message and pushes cluster-wide, so clients get it once per instance
clusterBus.on('price', (tick) => hub.to(`prices:${tick.symbol}`).emit('prices.tick', tick));

// Do: each instance pushes to its own connections
clusterBus.on('price', (tick) => hub.toLocal(`prices:${tick.symbol}`).emit('prices.tick', tick));
```

## Examples

### Count a user's devices across the cluster

```ts sample
import { DI } from '@spinajs/di';
import { principalKey } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { SocketHub, principalRoom } from '@spinajs/http-socket';

export async function devicesOnline(principal: Principal): Promise<{ cluster: number; here: number }> {
  const hub = (await DI.resolve(SocketHub)) as SocketHub;
  const room = principalRoom(principalKey(principal));
  const cluster = (await hub.connectionsIn(room)).length;
  const here = [...hub.Connections.values()].filter((c) => c.rooms.has(room)).length;
  return { cluster, here };
}
```

## Related

- [Rooms and server push](07-rooms-and-push.md): `to()` versus `toLocal()`.
- [Durable commands](12-durable-commands.md): shared idempotency stores.
- [Access change push](11-access-change-push.md): per-node pushes and the cluster change bus.
- [Shutdown and connection recovery](14-shutdown-and-recovery.md): local-only shutdown.
