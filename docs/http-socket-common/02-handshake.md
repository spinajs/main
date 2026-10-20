# Handshake

The `Handshake` is the socket.io `auth` object a client sends when it connects: the protocol version, a client id, an optional token and any app fields. The server reads it before it accepts the connection.

## How it works

1. The client builds `{ ...appFields, protocol: PROTOCOL_VERSION, clientId }`. `@spinajs/http-socket-client` takes `appFields` from its `auth` callback and sets `protocol` and `clientId` last, so app fields cannot override them.
2. socket.io sends it as `io(url, { auth })`.
3. `@spinajs/http-socket` checks it, in this order:
   1. The request origin against the CORS origins: `forbidden`.
   2. `protocol === PROTOCOL_VERSION`: `version_mismatch` with `details: { server: PROTOCOL_VERSION }`.
   3. `clientId` is a non-empty string of at most `MAX_ID_LENGTH` (128) printable ASCII characters (`isId`): `invalid_argument`.
   4. The principal sources identify the caller from the handshake (token, cookies, app fields): `unauthenticated` when they refuse.
4. A refused handshake rejects the connection with a socket.io `connect_error` whose `data` is the `SocketError`.
5. The client reads `data` with `isSocketError()`:
   - `unauthenticated`: it stops and emits `auth_required`.
   - `version_mismatch`: it stops and emits `incompatible`.
   - Any other non-retryable code except `internal`: it stops and emits `refused`.
   - Anything else: it retries, waiting `retryAfterMs` when the error carries one.

## `Handshake` fields

| Field | Type | Meaning |
| --- | --- | --- |
| `protocol` | `number` | Must equal `PROTOCOL_VERSION` (`1`). |
| `clientId` | `string` | Stable id of the client install; printable ASCII, at most 128 characters. Durable command keys are built from it. |
| `token` | `string?` | Bearer credential read by the server's principal sources. |
| `[key: string]` | `unknown` | App fields. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Handshake app fields | none, plain data | `{ protocol, clientId }`, plus `token` when the app sends one | none | Return extra fields from the client's `auth` callback; read them on the server from `ISocketHandshake.auth` in a principal source. |

### App fields: custom handshake data

`Handshake` has an index signature, so a client can send any extra field: a tenant, a device id, an app build. The server copies the whole `auth` object into `ISocketHandshake.auth`, where a `SocketPrincipalSource` of `@spinajs/http-socket` reads it.

Declare the app fields once, in the module the server and the client share:

```ts sample
import { PROTOCOL_VERSION, isId, type Handshake } from '@spinajs/http-socket-common';

/** The fields this app adds to every handshake. */
export interface TenantHandshake extends Handshake {
  token: string;
  tenant: string;
  appBuild: string;
}

/** Client side: what the `auth` callback of SocketClient returns. */
export function tenantAuth(token: string, tenant: string): () => Pick<TenantHandshake, 'token' | 'tenant' | 'appBuild'> {
  return () => ({ token, tenant, appBuild: '2026.10.1' });
}

/** Server side: read the fields from ISocketHandshake.auth inside a principal source. */
export function readTenant(auth: Readonly<Record<string, unknown>>): string | null {
  if (auth.protocol !== PROTOCOL_VERSION || !isId(auth.clientId)) {
    return null;
  }
  return typeof auth.tenant === 'string' && auth.tenant.length > 0 ? auth.tenant : null;
}
```

On the client, pass the callback to the client options:

```ts
const client = new SocketClient({ url, clientId, auth: tenantAuth(token, 'acme') });
```

## Important behaviour

- `protocol` and `clientId` always come from the client itself; an app field named `protocol` or `clientId` is overwritten.
- The `auth` callback runs on every connect attempt, so it can return a fresh token after a refresh.
- The origin check runs first: no principal source sees the credentials of a cross-site socket.
- App fields are untrusted client input. The server copies them as sent; validate each one where you read it.

## Best practices

- Keep `clientId` stable per install, e.g. persisted in storage. Durable command keys and ordering are built from it.
- Put credentials in `token` and use app fields for routing data (tenant, build). The authn principal source of `@spinajs/http-socket` turns `auth.token` into `Authorization: Bearer <token>` when the request has no `Authorization` header, since browsers cannot set WebSocket headers.
- Handle `version_mismatch` in the UI as "update the app": the client does not retry it.

## Patterns and antipatterns

```ts
// Don't: a random clientId on every page load breaks durable commands after a reload
const client = new SocketClient({ url, clientId: crypto.randomUUID(), outbox });

// Do: persist it once per install
const client = new SocketClient({ url, clientId: loadOrCreateClientId(), outbox });
```

## Related

- [Wire protocol](01-wire-protocol.md): the frames sent after the handshake.
- [Error codes and `SocketException`](04-error-codes.md): the `SocketError` a refused handshake carries.
- [`@spinajs/http-socket`](../../packages/http-socket/README.md): principal sources that read the handshake.
- [`@spinajs/http-socket-client`](../../packages/http-socket-client/README.md): the `auth` option and the `auth_required`, `incompatible` and `refused` events.
