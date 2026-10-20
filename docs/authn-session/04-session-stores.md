# Session stores

A session store keeps session rows. It is a `SessionProvider`: storage only. The issuer hashes ids and decides states; the store saves, reads, renews and deletes rows by the key it gets. Pick the store with `authn.session.service`.

## How it works

1. Importing a store package registers its class with `@Injectable(SessionProvider)`. `@spinajs/authn-session` registers `MemorySessionStore`.
2. `DefaultSessionIssuer` injects its store with `@AutoinjectService('authn.session', SessionProvider)`: the class named by `authn.session.service`, built with the whole `authn.session` object as its constructor options.
3. The store injects the [expiration strategy](03-expiration-strategies.md) named by `authn.session.expiration.service` into its protected `Expiration`.
4. Every issuer call maps to store calls: `issue`, `rotate`, `elevate` save; `restore` restores and touches; `set` touches; `revoke` deletes; `revokeAll` deletes by subject; `list` and `revokeHandle` list by subject.

| Store | Package | Select with | Notes |
| --- | --- | --- | --- |
| `MemorySessionStore` | `@spinajs/authn-session` | `'MemorySessionStore'` (shipped default) | One process; sessions are lost on restart. For tests and single-instance tools |
| `DbSessionStore` | [`@spinajs/session-provider-db`](../session-provider-db/README.md) | `'DbSessionStore'` | MySQL / MariaDB, PostgreSQL, SQLite through `@spinajs/orm`; table `user_sessions` |
| `RedisSessionStore` | [`@spinajs/session-provider-redis`](../session-provider-redis/README.md) | `'RedisSessionStore'` | One Redis server or a Sentinel group; not Redis Cluster |
| `DynamoDbSessionProvider` | [`@spinajs/session-provider-dynamodb`](../session-provider-dynamodb/README.md) | `'DynamoDbSessionProvider'` | One DynamoDB item per session |

Each store package documents its own keys under `authn.session` (`db`, `redis`, `aws`).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.session.service` | string | `'MemorySessionStore'` (shipped config; the schema has no default) | the class name of a registered `SessionProvider` | The store the issuer uses |
| `authn.session.expiration.service` | string | `'SlidingCappedExpiration'` | see [Expiration strategies](03-expiration-strategies.md#configuration) | The strategy every store uses |

```ts
authn: {
  session: {
    service: 'DbSessionStore',
  },
},
```

## Schema

`ISession` is the row every store keeps, whatever its physical layout.

### `ISession`

| Column | Type | Meaning |
| --- | --- | --- |
| `SessionId` | `string` | Storage key: sha256 hex of the raw id (64 characters). A raw id never reaches a store |
| `Subject` | `IdentityRef` (`{ type, id }`) | The owner; while impersonating, the target. Stores index it |
| `Impersonator` | `IdentityRef`, optional | Set while impersonating. Stores index it, so revoking the impersonator reaches the session |
| `State` | `'active' \| 'pending'` | A pending (pre-MFA) session yields no principal and is never extended |
| `Creation` | luxon `DateTime` | When the session was issued; `rotate` and `elevate` keep it |
| `Expiration` | luxon `DateTime`, optional | Absolute expiration instant; `undefined` never expires |
| `Data` | `Map<string, unknown>` | Opaque to the store: values written with `set`, plus the issuer's own `authn:` entries (facts, pending steps, last seen) |

`UserSession` is the class the issuer builds rows with. `new UserSession(partial)` assigns the given fields over the defaults: `State: 'active'`, `Creation: DateTime.now()`, `Expiration: undefined`, an empty `Data`. `SessionId` has no default. It is `@NewInstance()`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Session store | `SessionProvider` (abstract, extends `AsyncService`); each store registers with `@Injectable(SessionProvider)`, singleton; selected by name from `authn.session.service` | `MemorySessionStore` | `DbSessionStore`, `RedisSessionStore`, `DynamoDbSessionProvider` | Name another registered store in config, subclass a store, or write one: [Writing a session store](05-writing-a-session-store.md) |
| Expiration strategy | `SessionExpirationProvider`, injected into each store | `SlidingCappedExpiration` | `AbsoluteExpiration`, `SlidingExpiration` | [Expiration strategies](03-expiration-strategies.md) |

The `SessionProvider` contract:

| Method | Answers | Contract |
| --- | --- | --- |
| `restore(sessionId)` | `ISession \| null` | `null` for a missing or expired row |
| `save(session)` | `void` | Upsert. Stores `Expiration` as given; only a row without one gets `initial()` |
| `touch(session)` | `boolean` | Update-only: writes `Expiration` and `Data` of a row that still exists, never re-creates a deleted one. Renews through `applyRenewedExpiration()`, so a pending row is never extended. `true` when the expiration changed and was written |
| `delete(sessionId)` | `boolean` | One atomic operation; `true` only when this call removed the row |
| `deleteBySubject(subject, { includeImpersonations?, except? })` | `number` | Deletes rows of `Subject`, and with `includeImpersonations` rows of `Impersonator`; `except` is a storage key to keep. Returns the count of live rows deleted |
| `listBySubject(subject, { includeImpersonations? })` | `ISession[]` | Live rows only, same matching as `deleteBySubject` |
| `truncate()` | `void` | Deletes every row |
| `isExpired(session)` | `boolean` | `true` when `Expiration` is set and at or before now. Public, so `DefaultSessionIssuer` judges a row the way its store does |

Protected helpers for stores: `applyInitialExpiration(s)`, `applyRenewedExpiration(s)` and the injected `Expiration` strategy.

### `MemorySessionStore`

- Keeps live `ISession` objects in a `Map` keyed by `SessionId`; nothing is serialized, so `Data` values keep their identity.
- `restore` deletes an expired row when it meets it, then answers `null`.
- Every 256th `save` also drops every expired row, so abandoned sessions that are never restored again do not pile up.
- `deleteBySubject` and `listBySubject` scan every row.
- It is per process: two app instances do not see each other's sessions, and a restart logs everyone out.

## Important behaviour

- **The store never sees raw ids.** Use only the `SessionId` you get; never hash it again, never look up anything by a cookie value.
- **Expired means absent.** Every read answers `null` for an expired row, whether or not the store has swept it yet.
- **`touch` never resurrects.** A row deleted by a logout or ban between the issuer's read and its write stays deleted. This is what makes revocation win over a concurrent request.
- **`save` is an upsert** and stores `Expiration` verbatim, so a rotation copies the deadline instead of resetting it.
- **One strategy for all.** `Expiration` is injected in the `SessionProvider` base, so every store applies the same timeouts.

## Best practices

- Use `MemorySessionStore` only in tests and single-process tools. Any app behind a load balancer, or one that restarts while users are signed in, needs a shared store.
- Select stores by name in config and inject `SessionIssuer` in your code, not a store class; the issuer adds hashing and the revocation guarantees.
- Read a store directly only for operations the issuer does not offer, such as a count of active sessions for a dashboard (`listBySubject`).

## Patterns and antipatterns

```ts
// Don't: save a row you built yourself; the id is not hashed and the facts entry is missing, so restore answers null
await store.save(new UserSession({ SessionId: rawId, Subject: { type: 'user', id: userUuid } }));

// Do: let the issuer create the row
const handle = await sessions.issue({ type: 'user', id: userUuid }, facts);
```

## Examples

### Start every integration test signed out

Run the suite with `authn.session.service: 'MemorySessionStore'`, then empty the store before each test:

```ts sample
import { DI } from '@spinajs/di';
import { MemorySessionStore } from '@spinajs/authn-session';

/** Mocha `beforeEach` hook: no session of a previous test survives. */
export async function clearSessions(): Promise<void> {
  const store = await DI.resolve(MemorySessionStore);
  await store.truncate();
}
```

Resolve a store by its class, as here, when you need it directly. The issuer gets the one `authn.session.service` names.

## Related

- [Writing a session store](05-writing-a-session-store.md): implement the contract above.
- [Session data codec](06-session-data-codec.md): how persistent stores serialize `Data`.
- [`@spinajs/session-provider-db`](../session-provider-db/README.md), [`@spinajs/session-provider-redis`](../session-provider-redis/README.md), [`@spinajs/session-provider-dynamodb`](../session-provider-dynamodb/README.md): the persistent stores.
- [Config-selected services](../configuration/08-config-selected-services.md): how `@AutoinjectService` resolves the store.
