# RBAC Session Layer — Refactor Design

- **Date:** 2026-07-24
- **Status:** Approved (architecture) — spec covers **Sub-project A** in detail; B–E scoped as follow-ups.
- **Branch:** `feat/rbac-session-refactor` (based on `fix/rbac-audit-fixes`)
- **Breaking change:** yes — `@spinajs/rbac` `SessionProvider` / `ISession` contract changes (major version bump).

## 1. Motivation

An audit of the session layer (`@spinajs/rbac` contract + `MemorySessionStore`, and the
`session-provider-db`, `session-provider-dynamodb`, `session-provider-redis` packages)
found the expiration semantics, the ownership identity, and the provider contract to be
inconsistent across the three real stores, with several outright bugs and a stub Redis
package. This refactor unifies the contract, makes expiration a configurable strategy,
fixes the bugs, and implements the missing Redis provider.

### 1.1 Confirmed bugs (traceability)

| # | Bug | Fixed by |
|---|-----|----------|
| B1 | `rbac.session.expiration` interpreted 3 ways: `UserSession.extend()` as **seconds** (→2 min), login cookie `maxAge = expiration*1000` (→2 min), DB/Dynamo `save()` as **minutes** (→2 h). Cookie always dies at 2 min. | §4 (strategy owns TTL; cookie maxAge = strategy expiry) |
| B2 | `DbSessionStore` reads `rbac.session.db.cleanupInteval` (typo, missing “r”); config defines `cleanupInterval` → configured value ignored. | §7 (B) |
| B3 | `DbSessionStore.save` recomputes `now + default` on every save, discarding `session.Expiration` (so `extend()` and renewals are lost, expiry resets on every role-switch/2fa/impersonation save). | §3 (stores persist `Expiration` verbatim) |
| B4 | `DynamoDbSessionProvider.logsOut` filters on `Data.User` as a nested attribute, but `Data` is a scalar JSON string → matches nothing; Dynamo also never persists `UserId`. | §5 + §7 (C) |
| B5 | Serialization asymmetry: `replacer` on write (DB/Dynamo) but plain `JSON.parse` on read (no reviver). Latent (only strings/bools/uuids stored today). | §6 (shared codec) |
| B6 | Dead `save(id, data)` overload implemented inconsistently (Memory merges; DB overwrites + resets + `UserId=null` violating NOT NULL FK; Dynamo overwrites without `replacer`). | §2 (removed) |
| B7 | `touch()` declared, implemented 3 ways, never called → no sliding expiration. | §2 + §4 (given real meaning + wired) |
| B8 | Split identity: `ISession.UserId` (numeric) vs `Data['User']` (uuid); Memory/DB log out by `UserId`, Dynamo by `Data.User`; no single source of truth. | §5 |

### 1.2 Missing features

- `session-provider-redis` is an empty stub (0-byte `index.ts`, boilerplate package.json).
- No sliding expiration / renew-on-activity.
- No session-fixation protection (session id not regenerated on privilege elevation).
- No "list / revoke my active sessions" capability.
- `session-provider-dynamodb` on deprecated `aws-sdk` v2.

## 2. Decisions (locked)

1. **Break the contract freely** (major bump); update all in-repo consumers together.
2. **Ownership = numeric `UserId`**, persisted by every store; `deleteByUser(userId)` is uniform. `Data['User']` remains the uuid used only for request-time user resolution.
3. **Expiration = configurable injectable strategies** — absolute-cap, sliding, sliding+cap — each with its own settings, selected by config service name.
4. **Redis client = `ioredis`.**

## 3. Decomposition & sequencing

Each sub-project gets its own spec → plan → implementation cycle. The contract is the
linchpin, so **A first**; B/C/D conform to it and reuse the conformance kit built in A.

- **A. Core contract + expiration strategies + Memory store + http lifecycle + conformance kit** — this document.
- **B. `session-provider-db`** — conform, fix B2/B3, persist/logout by `UserId`, tests.
- **C. `session-provider-dynamodb`** — conform, fix B4, persist `UserId`, migrate to `@aws-sdk/client-dynamodb` v3 (to be confirmed at C), tests.
- **D. `session-provider-redis`** — implement from scratch with `ioredis`, conform, tests.
- **E.** Conformance kit is produced in A and consumed by B/C/D.

The rest of this document specifies **Sub-project A**.

---

## 4. Sub-project A — the contract

### 4.1 `ISession`

```ts
export interface ISession {
  SessionId: string;
  UserId: number;            // single source of truth for ownership (0 / -1 = anonymous)
  Creation: DateTime;
  Expiration?: DateTime;     // absolute instant; undefined = never expires
  Data: Map<string, unknown>;
}
```

Removed from the interface: `extend()` (moves to the expiration strategy).

### 4.2 `SessionProvider`

```ts
export abstract class SessionProvider extends AsyncService {
  /** null when missing OR expired (providers must treat an expired row as absent). */
  abstract restore(sessionId: string): Promise<ISession | null>;

  /** Upsert. MUST persist session.Expiration verbatim (never recompute it). */
  abstract save(session: ISession): Promise<void>;

  /**
   * Recompute Expiration via the strategy; if it changed, persist and report true so the
   * caller refreshes the cookie. If unchanged (e.g. AbsoluteExpiration), skip the write and
   * return false. This is what makes `touch` a genuine no-op under absolute mode.
   */
  abstract touch(session: ISession): Promise<boolean>;

  abstract delete(sessionId: string): Promise<void>;

  /** Log a user out of all devices. Keyed on numeric UserId in every store. */
  abstract deleteByUser(userId: number): Promise<void>;

  /** All live (non-expired) sessions for a user — powers "active devices" / selective revoke. */
  abstract listByUser(userId: number): Promise<ISession[]>;

  abstract truncate(): Promise<void>;
}
```

Removed: the `save(id: string, data: object)` overload (B6).
Renamed: `logsOut(user: User)` → `deleteByUser(userId: number)` (B8) — drops the `User`
model dependency from the store contract.

The abstract base provides concrete helpers so stores conform with one call:

```ts
@AutoinjectService('rbac.session.expiration')
protected Expiration: SessionExpirationProvider;

protected applyInitialExpiration(s: ISession): void { s.Expiration = this.Expiration.initial(s); }
protected applyRenewedExpiration(s: ISession): void { s.Expiration = this.Expiration.renew(s); }
protected isExpired(s: ISession): boolean { return !!s.Expiration && s.Expiration <= DateTime.now(); }
```

## 5. Sub-project A — expiration strategy

Injectable service resolved by config name, mirroring the existing `rbac.password` /
`rbac.password.validation` pattern.

```ts
export abstract class SessionExpirationProvider {
  /** Expiration to set when a session is first created. undefined = never expires. */
  abstract initial(session: ISession): DateTime | undefined;
  /** Expiration to set when a session is renewed (touch). */
  abstract renew(session: ISession): DateTime | undefined;
}
```

Three shipped implementations, each `@Injectable(SessionExpirationProvider)`:

| Service | `initial` | `renew` | Settings |
|---------|-----------|---------|----------|
| `AbsoluteExpiration` | `Creation + ttl` | returns current `Expiration` (no slide) | `ttl` |
| `SlidingExpiration` | `now + ttl` | `now + ttl` | `ttl` |
| `SlidingCappedExpiration` | `now + ttl` | `min(now + ttl, Creation + maxLifetime)` | `ttl`, `maxLifetime` |

**Units: minutes** (matches the existing config intent; documented explicitly).

### 5.1 Config shape (breaking)

Replaces the bare `session.expiration: 120`:

```ts
rbac: {
  session: {
    service: 'MemorySessionStore',
    expiration: {
      service: 'SlidingCappedExpiration',  // AbsoluteExpiration | SlidingExpiration | SlidingCappedExpiration
      ttl: 120,          // minutes
      maxLifetime: 1440, // minutes (SlidingCappedExpiration only)
    },
    cookie: { /* passthrough express cookie opts, unchanged */ },
  },
}
```

Each strategy reads its own settings from `rbac.session.expiration.*`, so a mode only needs
the keys it uses.

## 6. Sub-project A — identity, lifecycle & http

- **Ownership:** `session.UserId` set at login and preserved thereafter; `Data['User']`
  (uuid) is set/rewritten by impersonation for request-time resolution only. Impersonation
  keeps `UserId` = the impersonator, so "log me out everywhere" still targets the real
  actor. `deleteByUser` and `listByUser` are keyed on `UserId`.
- **Cookie unit fix (B1):** login (and any renewal) sets `maxAge` from the session's
  `Expiration` (`Expiration.diff(now).milliseconds`), not `expiration * 1000`.
- **Sliding renewal:** `RbacMiddleware.before` calls `SessionProvider.touch(session)` on an
  authenticated request; when it returns `true` (expiry changed) the middleware refreshes the
  `ssid` cookie `maxAge`. Under `AbsoluteExpiration`, `touch` returns `false`, performs no
  store write, and the cookie is not rewritten.
- **Session-fixation protection:** a `regenerateSession(session)` helper (in `@spinajs/rbac`)
  mints a new `SessionId`, copies `Data`/`UserId`/`Creation`, `delete`s the old id, `save`s the
  new one, and returns it so the caller resets the `ssid` cookie. Applied on privilege
  elevation: **2FA authorize** (`TwoFactorAuthController.verifyToken`) and **role switch**
  (`ActiveRoleController.switchActiveRole`). Login already mints a fresh session.

## 7. Sub-project A — shared serialization codec (B5)

A single `encodeSessionData(map) / decodeSessionData(json)` pair in `@spinajs/rbac`,
used by every persistent store, so write (`replacer`) and read (reviver) are symmetric and
DateTime round-trips. Memory store keeps live objects and does not serialize.

## 8. Sub-project A — conformance test kit (E)

A reusable, provider-agnostic suite `runSessionProviderConformance(() => provider)` exported
from `@spinajs/rbac` test utils, asserting the full contract against any store:

- save → restore round-trip (incl. `Data` types & `UserId`);
- `restore` returns null for missing and for expired sessions;
- `touch` renews per the active strategy (sliding extends, absolute no-ops, capped clamps);
- `delete`, `deleteByUser` (multi-session, keyed on `UserId`), `listByUser`, `truncate`;
- expiration persisted verbatim by `save` (regression for B3).

`MemorySessionStore` is the first consumer (A); B/C/D each run the same kit.

## 9. Testing strategy (A)

- Unit tests for each expiration strategy (initial/renew, cap clamping, minutes math).
- Conformance kit run against `MemorySessionStore`.
- Controller tests: cookie `maxAge` derived from expiry; regeneration issues a new id and
  invalidates the old on 2FA-authorize and role-switch.
- `RbacMiddleware` test: authenticated request slides expiry (sliding mode) and is a no-op
  (absolute mode).

## 10. Out of scope for A

- Store implementations B/C/D (own specs).
- `aws-sdk` v3 migration (decided at C).
- Redis (D).
- Any non-session rbac concerns.

## 11. Risks & notes

- Breaking config change (`session.expiration` scalar → object) — call out in the changelog
  and update all in-repo config fixtures/tests.
- The test harness build fixes this branch inherits from `fix/rbac-audit-fixes` are assumed
  to land first (or this branch stays based on it).
- Middleware-driven `touch` on every authenticated request adds one store write per request
  under sliding mode; acceptable for db/redis/dynamo, and a no-op under absolute mode for
  latency-sensitive deployments.
