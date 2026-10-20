# `@spinajs/authn-session`

Server-side sessions for SpinaJS authentication. `DefaultSessionIssuer` implements the `SessionIssuer` contract of `@spinajs/authn`: it issues, restores, rotates, elevates and revokes sessions, and keeps them in a `SessionProvider` store chosen by config.

It does **not** authenticate anyone: `AuthnService` in `@spinajs/authn` decides when a session is issued. It does **not** read or set cookies on a request: `@spinajs/authn-http` does, with the cookie builders of this package. There is no JWT or other self-contained session format: the cookie carries an opaque random id, and all session state lives in the store.

## Install

```sh
npm install @spinajs/authn-session
```

Add a persistent store for anything beyond one process: [`@spinajs/session-provider-db`](../session-provider-db/README.md), [`@spinajs/session-provider-redis`](../session-provider-redis/README.md) or [`@spinajs/session-provider-dynamodb`](../session-provider-dynamodb/README.md).

## Features

| Feature | What it does |
| --- | --- |
| [Issuing and restoring sessions](01-issuing-and-restoring-sessions.md) | `DefaultSessionIssuer`: `issue`, per-request `restore`, `peek`, `rotate`, `elevate` (pending to active) and `set`; hashed ids and handles |
| [Revocation and the session list](02-revocation-and-session-list.md) | `revoke`, `revokeAll`, `revokeHandle` and `list`: logout, "sign out everywhere", the device list |
| [Expiration strategies](03-expiration-strategies.md) | Idle and absolute timeouts: `AbsoluteExpiration`, `SlidingExpiration`, `SlidingCappedExpiration`, and your own `SessionExpirationProvider` |
| [Session stores](04-session-stores.md) | The `SessionProvider` contract, the `ISession` row, `UserSession`, `MemorySessionStore`, and how the shipped stores plug in |
| [Writing a session store](05-writing-a-session-store.md) | A `SessionProvider` of your own: the rules every store keeps, a complete example, the conformance suites |
| [Session data codec](06-session-data-codec.md) | `encodeSessionData` and `decodeSessionData`: the JSON form of `ISession.Data` that persistent stores share |
| [Session cookie](07-session-cookie.md) | `sessionCookie`, `clearSessionCookie` and the `authn.session.cookie` keys: name, `__Host-` prefix, `Secure`, `SameSite`, the signing secret check |
| [Custom session class](08-custom-session-class.md) | Register a `Session` subclass so `restore` returns typed reads of your own session data |
| [Extending the session issuer](09-extending-the-session-issuer.md) | Subclass `DefaultSessionIssuer` and register it as `SessionIssuer`; the protected hooks |
| [2.x session migration](10-2x-session-migration.md) | How a session written by SpinaJS 2.x keeps working: lookup by raw id, re-keying under the hash, revocation of unmigrated rows |

## Quick start

Importing the package registers `DefaultSessionIssuer`, `MemorySessionStore` and the three expiration strategies. The package ships this configuration, which the configuration loader merges like every package config file:

```ts
authn: {
  session: {
    service: 'MemorySessionStore',
    expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 }, // minutes
    pendingTtlSeconds: 300,
    cookie: { name: 'ssid', hostPrefix: 'auto', secure: 'auto', sameSite: 'strict' },
  },
},
```

Logins issue sessions through `AuthnService`. Your code mostly lists and ends them:

```ts sample
import '@spinajs/authn-session';
import { DI } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { SessionHandle } from '@spinajs/authn/contracts';

/** "Sign out on all other devices": keeps the caller's own session. */
export async function signOutOtherDevices(userUuid: string, current: SessionHandle): Promise<number> {
  const sessions = await DI.resolve(SessionIssuer);
  return sessions.revokeAll({ type: 'user', id: userUuid }, { except: current });
}

/** The device list of the account page. */
export async function devices(userUuid: string, current: SessionHandle) {
  const sessions = await DI.resolve(SessionIssuer);
  return sessions.list({ type: 'user', id: userUuid }, { current });
}
```

## Related packages

- [`@spinajs/authn`](../authn/README.md): the [session contract](../authn/08-session-contract.md) (`SessionIssuer`, `Session`), the [authentication flow](../authn/01-authentication-flow.md) that issues and elevates sessions, and the [`authn.*` config schema](../authn/13-configuration-and-boot-checks.md).
- [`@spinajs/authn-http`](../authn-http/README.md): `AuthnMiddleware` restores the session cookie on every request; the login, logout, MFA and session routes call the issuer.
- [`@spinajs/session-provider-db`](../session-provider-db/README.md), [`@spinajs/session-provider-redis`](../session-provider-redis/README.md), [`@spinajs/session-provider-dynamodb`](../session-provider-dynamodb/README.md): persistent `SessionProvider` stores.
- [`@spinajs/http`](../http/20-cookies.md): parses and signs cookies with `http.cookie.secret`.
- [`@spinajs/http-socket`](../http-socket/09-revalidation.md): socket revalidation; `@spinajs/authn-http`'s socket session source runs it inside `peekingSessions`, so a sweep never extends a session.
- [`@spinajs/configuration`](../configuration/08-config-selected-services.md): `@AutoinjectService`, which picks the store and the expiration strategy by name.
- [`@spinajs/authn-testing`](../authn-testing/README.md): `MemorySessionIssuer` and `runSessionIssuerConformance()` for tests of your own store or issuer.
