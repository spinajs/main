# Configuration

Everything the socket server reads lives under `http.socket`, plus `system.dirs.socketControllers` for controller discovery. The package ships the defaults below and a JSON schema that refuses a bad value when the configuration loads.

## How it works

1. Importing the package registers `SOCKET_CONFIGURATION_SCHEMA` (`registerConfigurationSchemaAtImport`), and `SocketConfigBootstrapper` registers it again at bootstrap.
2. The configuration loads the package defaults (`lib/*/config/http-socket.js`) and merges your files over them.
3. The schema validates `http.socket`. A bad value fails the boot with `InvalidConfiguration`, which names the full path of every bad key (`http.socket.rate.burst`).
4. `SocketServer.resolve()` checks what the schema does not: `idempotency`, `shutdownRetryAfterMs` and the upper bound of `drainMs`. A bad value throws `RangeError`.
5. `SocketServer` warns when `drainMs + 3000` reaches `http.shutdownTimeout`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.socket.path` | string | `'/socket.io'` | non-empty | socket.io endpoint |
| `http.socket.cors.origins` | string[] | `[]` | exact origins, no wildcards | Other origins allowed to open a socket |
| `http.socket.auth.required` | boolean | `false` | `true`, `false` only | Refuse handshakes no source resolves |
| `http.socket.auth.revalidateMs` | number | `60000` | 0 or more | Principal re-check interval; `0` turns it off (expiry still applies) |
| `http.socket.pingInterval` | integer | `25000` | 1 to 2^31-1 | socket.io heartbeat interval |
| `http.socket.pingTimeout` | integer | `20000` | 1 to 2^31-1 | socket.io heartbeat timeout |
| `http.socket.recovery.maxDisconnectionMs` | number | `120000` | 0 or more | Connection state recovery window; `0` turns recovery off |
| `http.socket.maxPayloadBytes` | integer | `1048576` | above 0 | Command and event payload limit |
| `http.socket.maxInFlightPerConnection` | integer | `32` | above 0 | Commands running at once per connection |
| `http.socket.maxInFlightEventsPerConnection` | integer | `128` | at least `rate.burst` | Events waiting or running per connection |
| `http.socket.rate.perSecond` | number | `50` | above 0 | Token refill per second, per connection |
| `http.socket.rate.burst` | number | `100` | above 0 | Token bucket size |
| `http.socket.ordering.abortGraceMs` | number | `30000` | (0, 2^31-1] | How long an aborted `ordered` command keeps its queue place |
| `http.socket.hooks.connectTimeoutMs` | number | `10000` | (0, 2^31-1] | How long commands and events wait for connect hooks |
| `http.socket.idempotency.service` | string | `'MemoryIdempotencyStore'` | a class registered under `IdempotencyStore` | The idempotency store; the whole object is its constructor argument |
| `http.socket.idempotency.ttlMs` | number | `600000` | (0, 2^31-1] | How long a completed key replays |
| `http.socket.idempotency.maxEntries` | integer | `100000` | above 0 | Completed keys kept by `MemoryIdempotencyStore`; checked for every store |
| `http.socket.drainMs` | number | `5000` | 0 to 2^31-1 | Shutdown drain |
| `http.socket.shutdownRetryAfterMs` | number | `5000` | finite, above 0 | `retryAfterMs` of `sys.shutdown` and drain refusals |
| `http.socket.streams.maxCredits` | integer | `64` | above 0 | Largest stream credit window |
| `http.socket.streams.maxPerConnection` | integer | `8` | above 0 | Open streams per connection |
| `http.socket.streams.stallTimeoutMs` | integer | `60000` | 1 to 2^31-1 | Stall timeout of a stream |
| `http.socket.transports` | string[] | `['websocket', 'polling']` | unique `'websocket'`, `'polling'`, at least one | engine.io transports; absent leaves socket.io's default |
| `http.socket.adapter` | adapter | `undefined` | a socket.io adapter | Rooms and pushes across instances |
| `system.dirs.socketControllers` | string[] | `[]` | folders | Folders scanned for socket controllers |

Keys of other packages the server reads: `http.trustProxy`, `authn.http.trustProxy` (client address), `http.shutdownTimeout` (drain warning), `configuration.isProduction` (`internal` error details), `authz` (field settings of `fields: 'filter'`).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SocketConfigBootstrapper` | `Bootstrapper`, singleton | registers `SOCKET_CONFIGURATION_SCHEMA` | none | Not meant to be replaced; register your own schema for your own keys |
| Configuration values | `Configuration` (`@spinajs/configuration`) | package defaults merged under your files | A `FrameworkConfiguration` subclass, config files, other sources | See [`@spinajs/configuration`](../configuration/README.md) |

### Settings from code

An app that builds its configuration in code overrides the keys in `onLoad()`; the package defaults are merged under it.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

export class SocketAppConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      http: {
        socket: {
          auth: { required: true, revalidateMs: 30_000 },
          transports: ['websocket'],
          cors: { origins: ['https://app.example.com'] },
          streams: { maxCredits: 16 },
        },
      },
    };
  }
}

DI.setESMModuleSupport();
DI.register(SocketAppConfiguration).as(Configuration);
```

## Important behaviour

- The configuration coerces types: a numeric string reads as its number. `NaN` and `Infinity` are refused.
- `null` and booleans are refused for `auth.revalidateMs`, `drainMs`, `recovery.maxDisconnectionMs`, `hooks.connectTimeoutMs`, `ordering.abortGraceMs`, `pingInterval` and `pingTimeout`: coercion would read `null` and `false` as 0, which turns revalidation, the drain or recovery off, and `true` as 1 ms.
- `auth.required` takes only `true` or `false`; `'true'` or `1` fail.
- `rate`, `maxPayloadBytes`, `maxInFlightPerConnection`, `maxInFlightEventsPerConnection`, `auth`, `hooks`, `ordering` and `streams` are required; removing one fails the boot.
- `idempotency.maxEntries` is checked even when another store is selected.
- `system.dirs.socketControllers` must not overlap `system.dirs.controllers`: the http loader scans those.

## Best practices

- Change only the keys you need; the defaults are tuned to work together (`maxInFlightEventsPerConnection` ≥ `rate.burst`, `drainMs` + 3 s < `http.shutdownTimeout`).
- Raise `http.shutdownTimeout` whenever you raise `drainMs`.
- Set `configuration.isProduction: true` in production to hide `internal` error details.

## Patterns and antipatterns

```ts
// Don't: false turns revalidation off through coercion; the schema refuses it
http: { socket: { auth: { revalidateMs: false } } }

// Do: 0 states the intent
http: { socket: { auth: { revalidateMs: 0 } } }
```

## Examples

### Read the effective socket settings at startup

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import type { ISocketServerConfig } from '@spinajs/http-socket';

export async function logSocketSettings() {
  const cfg = await DI.resolve(Configuration);
  const socket = cfg.get<ISocketServerConfig>('http.socket');
  console.log(`sockets at ${socket.path}, transports ${socket.transports.join(', ')}, revalidate every ${socket.auth.revalidateMs} ms`);
}
```

## Related

- [`@spinajs/configuration`](../configuration/README.md): sources, merging and schema validation.
- [Socket server and HTTP host](01-socket-server.md): how the keys shape socket.io.
- Every feature page lists the keys it reads.
