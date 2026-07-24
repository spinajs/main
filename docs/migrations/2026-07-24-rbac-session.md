# Migration — RBAC session layer (breaking)

Applies to apps upgrading `@spinajs/rbac` and the session-store packages
(`session-provider-db`, `session-provider-dynamodb`, `session-provider-redis`)
past the session refactor. This is a **major/breaking** change.

## 1. Config: `rbac.session.expiration` is now an object

Before:

```ts
rbac: {
  session: {
    service: 'MemorySessionStore',
    expiration: 120, // minutes (but interpreted inconsistently across the stack)
  },
}
```

After:

```ts
rbac: {
  session: {
    service: 'MemorySessionStore',
    expiration: {
      // AbsoluteExpiration | SlidingExpiration | SlidingCappedExpiration
      service: 'SlidingCappedExpiration',
      ttl: 120,          // minutes — session lifetime / sliding window
      maxLifetime: 1440, // minutes — hard cap (SlidingCappedExpiration only)
    },
    cookie: { /* express cookie options passthrough (unchanged) */ },
  },
}
```

- **Units are minutes** everywhere now (previously the value was read as seconds in
  `extend()` and as `value * 1000` for the cookie `maxAge`, so cookies silently died
  after ~2 minutes). The cookie lifetime is now derived from the session's real
  expiration.
- Pick the mode per deployment:
  - `AbsoluteExpiration` — fixed lifetime from creation; no renewal.
  - `SlidingExpiration` — every authenticated request extends the session by `ttl`.
  - `SlidingCappedExpiration` — sliding, but never beyond `maxLifetime` from creation.

## 2. Behavior changes

- **Sliding renewal**: under a sliding mode, `RbacMiddleware` renews the session and the
  `ssid` cookie on each authenticated request. Under `AbsoluteExpiration` this is a no-op.
- **Session-fixation protection**: the session id is regenerated on privilege elevation
  (2FA authorize and active-role switch). Clients relying on a stable `ssid` across those
  transitions must re-read the cookie from the response.

## 3. Custom `SessionProvider` implementations

If you implemented your own store, the abstract contract changed:

| Old | New |
|-----|-----|
| `logsOut(user: User): Promise<void>` | `deleteByUser(userId: number): Promise<void>` |
| `touch(session): Promise<void>` | `touch(session): Promise<boolean>` (true = expiry changed & persisted) |
| `save(session)` **and** `save(id, data)` overload | `save(session)` only |
| — | `listByUser(userId: number): Promise<ISession[]>` (new; live sessions) |
| `ISession.extend(seconds?)` | removed — expiration comes from the injected strategy |

Additional rules:

- `ISession.UserId` (numeric) is the single source of truth for ownership; persist it and
  key `deleteByUser` / `listByUser` on it. `Data['User']` (uuid) is only for request-time
  user resolution.
- `save` must persist `session.Expiration` **verbatim**; only assign an initial expiration
  (via the base `applyInitialExpiration` helper) when a brand-new session has none.
- `restore` must return `null` for an expired session (use the base `isExpired` helper).
- Serialize `Data` with the exported `encodeSessionData` / `decodeSessionData` codec.
- The base class injects the expiration strategy at `rbac.session.expiration`
  (`@AutoinjectService`); reuse `applyInitialExpiration` / `applyRenewedExpiration`.

## 4. Store-specific config

- **db** (`session-provider-db`): the cleanup interval key is `rbac.session.db.cleanupInterval`
  (a prior typo, `cleanupInteval`, meant the configured value was ignored — now honored).
- **dynamodb** (`session-provider-dynamodb`): sessions now persist a top-level numeric
  `UserId` attribute; per-user logout (`deleteByUser`) queries it. Previously stored no
  `UserId` and could not log a user out of all devices.
- **redis** (`session-provider-redis`): newly implemented. Configure the ioredis client at
  `rbac.session.redis` (host/port/password/db/keyPrefix, passed straight to `new Redis(opts)`).
