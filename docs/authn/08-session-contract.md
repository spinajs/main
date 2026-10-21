# Session contract

`@spinajs/authn` defines what a session is and what a session issuer must do. It does not store sessions: [`@spinajs/authn-session`](../authn-session/README.md) implements `SessionIssuer`, and the `session-provider-*` packages store the rows. Use this page when you read session data or replace the `Session` class.

## How it works

1. An interactive login calls `SessionIssuer.issue(identity, facts, opts)`. It returns a `SessionHandle`: the raw id and the state, `pending` or `active`. The raw id lives only in memory and in the cookie.
2. Each request restores the session with `SessionIssuer.restore(rawId)`, which returns a `Session` or `null`.
3. The issuer builds the `Session` with `resolveSession(container, init)`: the class registered as `Session` in the container, or `Session` itself.
4. Code reads typed data with `session.get(key)`, where `key` is a `SessionKey` made by `sessionKey(name, decode)`.
5. `SessionIssuer.set(handle, key, value)` writes data; `rotate`, `elevate`, `reissue` and `revoke` change the session itself.

## The `SessionIssuer` contract

| Method | Obligation |
| --- | --- |
| `issue(identity, facts, { pending? })` | A new session. With `pending: { steps }`, a pre-MFA session that yields no principal and expires after `authn.session.pendingTtlSeconds` |
| `restore(rawId)` | Looks the session up by `sha256(rawId)` only, so a stored hash never works as an id |
| `rotate(handle)` | New id, same data |
| `elevate(handle, facts)` | `pending` to `active` at `aal2`, with a new id. Refuses an active session |
| `reissue(handle, change)` | An active session under a new id with `change` (`assurance: 'aal2'`, `mfa`, `authenticatedAt`) merged into its facts; data, subject and impersonator kept. Refuses a pending session. A revocation during the move stays in force |
| `set(handle, key, value)` | Writes one data entry. Never changes the subject, the impersonator or the state; the issuer refuses its reserved keys |
| `revoke(handle)` | Resolves `true` only for the call that ended the session, so of parallel revokes exactly one gets `true` |
| `revokeAll(subject, { except?, includeImpersonations? })` | Ends every session of an identity and returns the count. `includeImpersonations` also ends sessions where it is the impersonator |
| `revokeHandle(subject, handle)` | Ends one listed session, only when its subject is `subject` |
| `list(subject, { current? })` | The subject's sessions by hashed handle, with creation, last-seen time, IP and user agent. Includes sessions in which someone impersonates the subject |

Impersonation start and stop rely on `revoke`'s single `true`: only the call that ended the old session keeps its new one.

## The `Session` class

| Member | Meaning |
| --- | --- |
| `handle`, `state` | The `SessionHandle`; `state` is `pending` or `active` |
| `identity` | The `IdentityRef` the session belongs to |
| `facts` | `AuthnFacts` of the login |
| `data` | The raw public entries, a `ReadonlyMap` |
| `get(key)`, `has(key)` | Typed read of one entry through a `SessionKey`; `undefined` when absent |
| `impersonator`, `activeRole`, `impersonation`, `ip`, `userAgent`, `pendingSteps` | Shortcuts for the keys below |

`SessionKeys`, the keys authn reads:

| Key | Stored name | Decodes to |
| --- | --- | --- |
| `ActiveRole` | `ActiveRole` | The role of a role switch; `''` narrows to no role |
| `Impersonation` | `Impersonation` | `{ startedAt, actorRoles? }`, or `null` when it cannot be read |
| `Ip`, `UserAgent` | `Ip`, `UserAgent` | A non-empty string |
| `PendingSteps` | `authn:pendingSteps` | The steps of a pending session; written by the issuer only |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SessionIssuer` | `SessionIssuer`; required by `DefaultAuthnService` | None in the core | `DefaultSessionIssuer` ([`@spinajs/authn-session`](../authn-session/README.md)) | Register with `@Injectable(SessionIssuer)`; prefer a new store under `authn-session` |
| `Session` | `Session`, new instance per session | `Session` | Your subclass | `DI.register(MySession).as(Session)`; the subclass must be `@NewInstance()` |

### Session: custom implementation

Add typed accessors for your own session data, such as the tenant a user picked:

```ts sample
import { DI, NewInstance } from '@spinajs/di';
import { Session, sessionKey } from '@spinajs/authn';

export const TenantId = sessionKey('TenantId', (raw) => (typeof raw === 'string' && raw !== '' ? raw : undefined));

@NewInstance()
export class TenantSession extends Session {
  public get tenantId(): string | undefined {
    return this.get(TenantId);
  }
}

DI.register(TenantSession).as(Session);
```

Write the value with `SessionIssuer.set(handle, TenantId.name, tenantId)`. Every restore then hands out a `TenantSession`.

`resolveSession` throws when the registered class is not a `Session`, when it resolves to a `Promise` (it depends on an `AsyncService`), or when DI hands out one instance twice (a singleton). Keep the subclass `@NewInstance()` and free of async dependencies.

## Important behaviour

- A pending session yields no principal and accepts only the MFA routes.
- The raw session id is never stored. Facts and events carry the hashed handle (`AuthnFacts.sessionHandle`, `AuthnEvent.session`).
- `elevate` refuses an active session, and `reissue` a pending one. Only `reissue` changes the facts of a live session, and the core calls it only from `AuthnService.stepUp`, after a verified factor. Earlier releases documented that the facts of a live session never change; an issuer outside this repository must now implement `reissue`.

## Related

- [`@spinajs/authn-session`](../authn-session/README.md): the issuer, the cookie and expiration.
- [`@spinajs/session-provider-db`](../session-provider-db/README.md), [`@spinajs/session-provider-redis`](../session-provider-redis/README.md), [`@spinajs/session-provider-dynamodb`](../session-provider-dynamodb/README.md): the session stores.
- [Impersonation and the active role](11-impersonation-and-active-role.md): the `Impersonation` and `ActiveRole` keys.
