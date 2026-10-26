# Principal sources and handshake security

A socket handshake is turned into an authz-v3 `Principal` by the registered `SocketPrincipalSource`s. Before any source reads credentials, the server checks the page's origin and computes the client address from trusted proxies.

## How it works

1. engine.io's `allowRequest` runs `crossSiteRefusal()` on every transport request, before a session opens:
   - a JSONP polling request (query parameter `j`) is refused;
   - a request without `Origin` whose `Sec-Fetch-Site` is `cross-site` or `same-site` is refused.
2. The handshake middleware runs `isAllowedOrigin()` first, so no source reads the credentials of a hijacked cross-site socket. A refusal answers `forbidden`.
3. `toHandshake()` builds the `ISocketHandshake`: `auth`, `headers`, the request's `rawHeaders`, raw `cookies`, the client `address`, `peerAddress`, `url`, `query`, `secure`, `issuedAt`.
4. After the protocol and `clientId` checks, `SocketServer.identify()` sorts the sources by ascending `order` and calls `authenticate(handshake)` on each:
   - the first non-null principal wins, and its source `name` is stored with it;
   - a throw refuses the handshake with the mapped error (`AuthenticationFailed` answers `unauthenticated`);
   - a `system` or `unattended` principal throws `AuthzConfigError` (answered `internal`): no credential may yield one.
5. No source answers: with `http.socket.auth.required` the handshake is refused with `unauthenticated`; otherwise the connection runs as `UNATTENDED` and `conn.authenticated` is `false`.
6. The principal, its source and the check time are kept in `socket.data.auth`, which connection state recovery restores. `SocketPrincipalGuard` re-checks it later (see [Principal revalidation](09-revalidation.md)).

### Origins

`isAllowedOrigin(headers, origins, secure)` admits:

- a request without `Origin` (not a browser; `crossSiteRefusal` closes the browser cases);
- a same-origin page: scheme, host and port equal to the request's `Host`. Behind a TLS-terminating proxy that keeps `Host`, an `https` page reaching a plain `http` server is admitted; never the reverse;
- an origin listed exactly in `http.socket.cors.origins`.

It refuses `Origin: null` and `Origin: *` always. CORS does not cover a WebSocket upgrade, and a browser sends the user's cookies with a socket opened from any site, so this check is the only cross-site guard.

### Client address

`handshake.address` is the socket's peer, or, behind trusted proxy hops, the `X-Forwarded-For` entry they vouch for. `handshake.peerAddress` is always the raw TCP peer.

- The trust comes from `authn.http.trustProxy`, else `http.trustProxy` when the former is `null` or absent (authn-http's `ClientIp` rule), parsed by `parseTrustProxy()`. An entry that is no address or CIDR throws `InvalidOption` when `SocketServer` resolves.
- Addresses are normalized even without a trust setting: trimmed, `::ffff:a.b.c.d` as plain IPv4.
- Socket `realIp` (in the call store) and policy `ip` use this address. They differ from http's `req.storage.realIp`, which reads `http.trustProxy` only, when the two settings differ.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.socket.auth.required` | boolean | `false` | `true`, `false` | Refuse handshakes no source resolves, instead of running them as `UNATTENDED` |
| `http.socket.cors.origins` | string[] | `[]` | exact origins, no wildcards | Other origins allowed to open a socket |
| `authn.http.trustProxy` | hops, list or `null` | `null` | see `@spinajs/http` `TrustProxySetting` | Trusted proxies for the client address; wins over `http.trustProxy` |
| `http.trustProxy` | hops, list or `null` | `null` | same | Used when `authn.http.trustProxy` is `null` or absent |

```ts
http: {
  trustProxy: ['10.0.0.0/8'],
  socket: {
    auth: { required: true },
    cors: { origins: ['https://app.example.com'] },
  },
},
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SocketPrincipalSource` | `SocketPrincipalSource`; every registered class, injected as a list (`@Autoinject(SocketPrincipalSource)`) into `SocketServer` and `SocketPrincipalGuard`; each a singleton | `AuthnCredentialSource` (`name: 'authn'`, `order: 50`) | `SessionSocketPrincipalSource` (`order: 40`) from `import '@spinajs/authn-http/socket'`; your sources | Add: `@Injectable(SocketPrincipalSource)` with a unique `name` and an `order`. Remove: `DI.unregister(AuthnCredentialSource)`. Extend: subclass and override `authenticate()` / `revalidate()`. All before `SocketServer` resolves |
| `AuthnCredentialSource` | registered under `SocketPrincipalSource`, singleton | `AuthnCredentialSource` | Your subclass | Override `authenticate()`, `revalidate()`, or the protected `context()` (the `AuthnContext`) and `extract()` (the credential extractors) |
| `CredentialExtractor` (`@spinajs/authn`) | list, sorted by `order`, resolved per handshake by `AuthnCredentialSource.extract()` | the extractors `@spinajs/authn` registers | Your extractor | `@Injectable(CredentialExtractor)`; it sees the handshake as a `SignedRequest` |

### `SocketPrincipalSource`: a source of your own

`authenticate(handshake)` returns a `Principal`, `null` when the handshake carries none of your credentials, or throws to refuse the connection. `revalidate(handshake, principal, check)` re-checks a live connection; the default authenticates the handshake again and compares `principalKey`s. Return the tri-state answer when your store can tell "revoked" from "unreachable".

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { AuthenticationFailed } from '@spinajs/exceptions';
import type { Principal } from '@spinajs/authz';
import { ISocketHandshake, ISocketRevalidation, SocketPrincipalSource, SocketRevalidationResult } from '@spinajs/http-socket';

interface ServiceKey {
  service: string;
  revoked: boolean;
}

@Injectable()
export class ServiceKeyStore {
  protected keys = new Map<string, ServiceKey>([['k-reporting-1', { service: 'reporting', revoked: false }]]);
  public online = true;

  public async find(key: string): Promise<ServiceKey | undefined> {
    if (!this.online) {
      throw new Error('key store unreachable');
    }
    return this.keys.get(key);
  }
}

/** Server-to-server clients send `io(url, { auth: { serviceKey } })`. */
@Injectable(SocketPrincipalSource)
export class ServiceKeySource extends SocketPrincipalSource {
  public readonly name = 'service-key';
  public readonly order = 60;

  @Autoinject()
  protected Keys: ServiceKeyStore;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const key = handshake.auth.serviceKey;
    if (typeof key !== 'string') {
      return null;
    }

    const found = await this.Keys.find(key);
    if (!found || found.revoked) {
      throw new AuthenticationFailed('unknown service key');
    }

    return Object.freeze({ type: 'service', id: found.service, authenticated: true, source: this.name, attributes: Object.freeze({}) });
  }

  public async revalidate(handshake: ISocketHandshake, principal: Principal, check?: ISocketRevalidation): Promise<SocketRevalidationResult> {
    const key = handshake.auth.serviceKey as string;
    try {
      const found = await this.Keys.find(key);
      return found && !found.revoked && found.service === principal.id ? 'valid' : 'invalid';
    } catch {
      // the store is down: keep the connection for one more grace window
      return 'unavailable';
    }
  }
}
```

### `AuthnCredentialSource`: accept a token from another header

`AuthnCredentialSource` turns the handshake into an authn `SignedRequest` (`credentialRequest(handshake, singletons?)`): every header but `Cookie`, plus `auth.token` as `Authorization: Bearer` when no `Authorization` header is set. A singleton credential header (`Authorization`, `Proxy-Authorization`, and the `authn.token.headerName` header, default `x-api-key`) that the client sent more than once throws `invalid_argument` with the message `the <name> header was sent more than once`, before any extractor runs; `@spinajs/authn-http` answers the same request with 400. Any other header the client sent twice is joined with `, ` from `rawHeaders`, as in `@spinajs/authn-http`; a value a subclass put in `headers` in place of the received one is kept. `credentialRequest()` called without `singletons` checks `SINGLETON_CREDENTIAL_HEADERS` only. A subclass can map another header before the default runs; override both methods so revalidation reads the same credential.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { AuthnCredentialSource, ISocketHandshake, ISocketRevalidation, SocketPrincipalSource, SocketRevalidationResult } from '@spinajs/http-socket';

function withApiToken(handshake: ISocketHandshake): ISocketHandshake {
  const header = handshake.headers['x-api-token'];
  return typeof header === 'string' && handshake.auth.token === undefined ? { ...handshake, auth: { ...handshake.auth, token: header } } : handshake;
}

/** Node clients send `extraHeaders: { 'x-api-token': token }`; browsers keep using auth.token. */
@Injectable(SocketPrincipalSource)
export class ApiTokenCredentialSource extends AuthnCredentialSource {
  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    return super.authenticate(withApiToken(handshake));
  }

  public async revalidate(handshake: ISocketHandshake, principal: Principal, _check?: ISocketRevalidation): Promise<SocketRevalidationResult> {
    return super.revalidate(withApiToken(handshake), principal);
  }
}

// the subclass keeps name 'authn' and order 50, so the original must go
DI.unregister(AuthnCredentialSource);
```

## Important behaviour

- `AuthnCredentialSource` is inert until an `AuthnService` is registered: it answers `null` at the handshake and `'unavailable'` at revalidation.
- `AuthnCredentialSource` never reads cookies: a browser sends them with a socket opened from any site. The client sends a token as `auth.token`, because browsers cannot set WebSocket headers.
- A failed authn attempt answers `unauthenticated` with the message `authentication failed` (`AUTHENTICATION_FAILED`); a throttled one adds `retryAfterMs`. An `mfa_required` result is no principal and refuses the handshake too.
- A repeated `Authorization`, `Proxy-Authorization` or `authn.token.headerName` header refuses the handshake with `invalid_argument`, not `unauthenticated`: the handshake is malformed, which a retry cannot fix, and the answer says nothing about the credential. No strategy runs and no failure is counted. At revalidation the same handshake answers `'invalid'`. A source that ran earlier (the session source, order 40) and gave a principal ends the chain first, as an active session ignores credential headers over http.
- Source `name`s must be unique: revalidation finds the source of a connection by `name`, and uses the first match.
- `@NewInstance()` sources are left out of the list (`Array.ofType`): a source marked so never runs.
- The source list is injected when `SocketServer` and `SocketPrincipalGuard` are built; a source registered later is never asked.
- `handshake.cookies` holds raw, unsigned values; verifying a signed cookie is the source's job.
- A connection without credentials runs as `UNATTENDED`: authz denies it, and scoped ORM queries fail closed.
- The session-cookie source of `@spinajs/authn-http/socket` resolves sessions as http does, and judges same-origin from `Host`, never `X-Forwarded-Host`. Cookie sockets rely on `http.socket.cors.origins` alone.

## Best practices

- Leave `order` gaps (10, 20 ...) so a later source can slot in between; lower runs first.
- Return `null` for "not my credential" and throw only for "my credential, and it is wrong": a throw stops the other sources.
- Set `http.socket.auth.required: true` for apps where every socket needs a user; it refuses anonymous handshakes before any handler runs.
- With cookie authentication, set `transports: ['websocket']` and list the public origin in `cors.origins` when a proxy rewrites `Host`.
- Implement `revalidate()` with the tri-state answer: `'unavailable'` keeps connections up through a short store outage, `'invalid'` closes at once.

## Patterns and antipatterns

```ts
// Don't: read a bearer token from the query string; URLs end up in proxy and access logs
const token = handshake.query.token;

// Do: send it in the handshake auth object, which travels in the first socket.io packet
const token = handshake.auth.token;
```

## Examples

### Check the client address of every handshake

```ts sample
import { Injectable } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import type { Principal } from '@spinajs/authz';
import { ISocketHandshake, SocketPrincipalSource } from '@spinajs/http-socket';

const BLOCKED = new Set(['203.0.113.7']);

/** Runs first and never resolves a principal; it only refuses blocked addresses. */
@Injectable(SocketPrincipalSource)
export class BlockedAddressSource extends SocketPrincipalSource {
  public readonly name = 'blocked-address';
  public readonly order = 0;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    if (BLOCKED.has(handshake.address)) {
      throw new Forbidden(`address ${handshake.address} is blocked`);
    }
    return null;
  }
}
```

## Related

- [Principal revalidation](09-revalidation.md): how `revalidate()` answers are used.
- [Policies and `@SocketAccess`](10-policies-and-access.md): what the principal is checked against per command.
- [Socket server and HTTP host](01-socket-server.md): the handshake order.
- [`@spinajs/authz`](../authz/README.md): `Principal`, `principalKey`, `UNATTENDED`.
- `@spinajs/authn` and `@spinajs/authn-http`: `AuthnService`, `CredentialExtractor`, `SessionSocketPrincipalSource`.
