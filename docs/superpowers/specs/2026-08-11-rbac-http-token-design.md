# Design: `@spinajs/rbac-http-token`

New package providing personal access token (PAT) authentication for spinajs HTTP routes,
integrated with the existing rbac role/grant system.

## Goals

- Generic token policy for securing routes.
- Tokens persisted in database; actions: create, delete, grant role, revoke role.
- Tokens assigned to users; a user can have multiple tokens.
- Tokens expire at a set date or live forever (two options).
- Tokens respect rbac roles — roles can be granted to and revoked from a token.
- Full controller API for creating and deleting tokens.
- CLI commands for creating/removing tokens and for deleting expired tokens
  (worker-friendly, cyclic cleanup).
- Injectable token generation algorithm, replaceable via configuration.
- Routes secured via `@Policy` — custom token policy plus supporting middleware.
- Full test coverage.

## 1. Token format & storage

- Opaque token: configurable prefix `spt_` + 32 crypto-random bytes, base64url encoded.
  Prefix enables secret scanning.
- Database stores only the SHA-256 hash of the full token (unique index). Plaintext is
  returned once at creation and never again; never logged.
- Lookup is by hash directly — 256-bit entropy behind a DB index compare, no timing
  concern.

## 2. Model + migration

`AccessToken` model (`@spinajs/orm`), table `rbac_access_tokens`, connection `default`:

| Column     | Notes                                                        |
| ---------- | ------------------------------------------------------------ |
| Id         | primary key                                                  |
| Uuid       | public identifier — API/CLI address tokens by uuid           |
| Name       | human label                                                  |
| Token      | SHA-256 hash of plaintext, unique index                      |
| user_id    | FK, `belongsTo(User)`                                        |
| Roles      | JSON array — roles allowed on this token                     |
| ExpiresAt  | datetime, nullable; `null` = never expires                   |
| CreatedAt  | creation timestamp                                           |
| LastUsedAt | nullable; updated throttled, fire-and-forget                 |

Migration `RbacHttpTokenInitial_<ts>` creates the table with indexes on Token (unique),
user_id, ExpiresAt.

Role revocation mutates the `Roles` list (grant adds, revoke removes) — no second
column. Deleting the token row is full revocation; hash-only storage means no
soft-delete requirement.

## 3. Actions (functional, `packages/rbac` `actions.ts` pattern)

`src/actions.ts` — plain exported async functions built with `_chain` / `_check_arg` /
`_ev` from `@spinajs/util` + `@spinajs/queue`, mirroring `@spinajs/rbac` actions:

- `createToken(user: User | number | string, name: string, roles: string[], expiresAt: DateTime | null)`
  → `{ Token: AccessToken; Plaintext: string }`. Validates `roles ⊆ user.Role`. Emits
  `AccessTokenCreated`.
- `deleteToken(tokenOrUuid: AccessToken | string)` — emits `AccessTokenDeleted`.
- `grantTokenRole(tokenOrUuid, role)` — role must be held by owner; emits
  `AccessTokenRoleGranted`.
- `revokeTokenRole(tokenOrUuid, role)` — emits `AccessTokenRoleRevoked`.
- `validateToken(plaintext: string)` → `{ User; Token; EffectiveRoles: string[] }` —
  hash lookup, expiry check, owner must be active / not banned / not deleted,
  `EffectiveRoles = Token.Roles ∩ User.Role`.
- `deleteExpiredTokens()` → deleted count. Used by CLI cleanup command.
- Internal helpers: `_get_token(tokenOrUuid)`, generation provider resolved via
  `_service('rbac.token.generation', AccessTokenGenerationProvider)`.

Events routed through queue config with BlackHole default connection, exactly like
rbac user events.

The only injectable service class is the generator:

```ts
export abstract class AccessTokenGenerationProvider {
  public abstract generate(): Promise<{ plaintext: string; hash: string }>;
  public abstract hash(plaintext: string): string;
}
```

Default implementation `SecureRandomTokenProvider` (crypto.randomBytes(32), base64url,
config prefix, SHA-256). Replaceable via config `rbac.token.generation.service` —
same pattern as `rbac.password.service`.

## 4. Auth wiring — `TokenAuthMiddleware`

`TokenAuthMiddleware extends ServerMiddleware`, mirror of `RbacMiddleware`:

1. Runs only when no session user is present (guest). Extracts token from
   `Authorization: Bearer <token>` or fallback header (config
   `rbac.token.headerName`, default `x-api-key`) — both accepted, Bearer first.
2. Calls `validateToken()`: hash, DB lookup, expiry check, owner state check.
3. Sets `req.storage.User` with `Role` narrowed to `EffectiveRoles`, sets
   `req.storage.ActiveRole`, and sets `req.storage.TokenAuth = { Uuid }` marker
   (declaration-merged into `IRbacAsyncStorage`).
4. Sends `Cache-Control: no-store`.
5. Updates `LastUsedAt` throttled (config interval), fire-and-forget.

Because `User.Role` is narrowed to effective roles, existing machinery —
`checkRoutePermission`, orm rbac query middleware, ownership checks — works unchanged
on token-authenticated requests. Invalid/expired token ⇒ request continues as guest
(policies then reject); middleware never throws for absent header.

## 5. Policies

- `TokenPolicy` — asserts request is token-authenticated (`req.storage.TokenAuth`
  set) and checks rbac grants via the existing `@Resource` / `@Permission` route
  descriptors (reuses `checkRoutePermission`). Usage: `@Policy(TokenPolicy)`.
- `NoTokenAuthPolicy` — rejects token-authenticated requests. Applied to the token
  management controller so tokens cannot create or manage tokens (no
  self-replication).

## 6. Controller — `AccessTokenController`

Session auth required: `NoTokenAuthPolicy` + `RbacPolicy`, resource `user.tokens`.

| Route                                   | Action                                          |
| --------------------------------------- | ----------------------------------------------- |
| `GET user/tokens`                       | list own tokens (uuid, name, roles, expiry, last used — never hashes) |
| `POST user/tokens`                      | create; dto `{ Name, Roles[], ExpiresAt?: ISO \| null }`; roles validated ⊆ own roles; returns plaintext once |
| `DELETE user/tokens/:uuid`              | delete own token                                |
| `PUT user/tokens/:uuid/roles/:role`     | grant role to token                             |
| `DELETE user/tokens/:uuid/roles/:role`  | revoke role from token                          |

Ownership enforced by `user_id` WHERE on every query. Shipped grants: role `user` →
own CRUD on `user.tokens`; `admin.users` → any (admins manage any user's tokens).

## 7. CLI commands (registered via `system.dirs.cli` config, rbac pattern)

- `rbac:token-create <userIdOrUuid> --name <name> --roles <r1,r2> [--expires <iso> | --infinite]`
  — prints plaintext once.
- `rbac:token-delete <uuid>`
- `rbac:token-grant <uuid> <role>` / `rbac:token-revoke <uuid> <role>`
- `rbac:token-delete-expired` — deletes expired tokens; intended for cyclic worker
  execution (precedent: `DeactivatePasswords`).

## 8. Configuration (`src/config/rbac-http-token.ts`)

```ts
{
  system: { dirs: { cli: [...dir('cli')], migrations: [...], models: [...] } },
  queue: { routing: { AccessTokenCreated: ..., /* BlackHole default */ } },
  rbac: {
    token: {
      generation: { service: 'SecureRandomTokenProvider' },
      prefix: 'spt_',
      length: 32,                 // random bytes
      headerName: 'x-api-key',    // fallback header, Bearer always accepted
      lastUsedUpdateInterval: 60, // seconds, throttle for LastUsedAt writes
    },
  },
}
```

## 9. Tests

Mocha/chai/sqlite, sibling package conventions:

- Generator unit tests (format, prefix, uniqueness, hash).
- Actions unit tests: create (role subset validation), validate (ok / expired /
  infinite / wrong token / banned / inactive / deleted owner / role intersection),
  grant/revoke role, deleteExpiredTokens.
- Middleware + policy e2e via http test harness: Bearer and fallback header, guest
  fallthrough on bad token, `TokenPolicy` grant enforcement, `NoTokenAuthPolicy`.
- Controller e2e: CRUD, ownership isolation, one-time plaintext, token-cannot-manage-
  tokens.
- CLI command tests.

## Security summary

Hash-only storage; one-time plaintext display; scanner-friendly prefix; effective
roles = intersection with owner's current roles; owner ban/deactivate/delete gates
every request; no session issued for token requests; tokens cannot manage tokens;
`Cache-Control: no-store`; logs carry token uuid, never token material.
