# @spinajs/rbac-http-token

Personal access tokens (PAT) for spinajs HTTP routes. Opaque `spt_...` tokens,
stored hashed (SHA-256), assigned to users, with rbac role intersection and
optional expiration.

## Securing a route

```ts
import { BaseController, BasePath, Get, Policy } from '@spinajs/http';
import { Permission, Resource } from '@spinajs/rbac-http';
import { TokenPolicy } from '@spinajs/rbac-http-token';

@BasePath('api')
@Resource('my.resource')
export class ApiController extends BaseController {
  @Get('data')
  @Permission(['readOwn']) // permission metadata + the RbacPolicy group
  @Policy(TokenPolicy) // METHOD level, BELOW @Permission
  public async data() { ... }
}
```

The placement is load bearing (see the docblock on `src/policies/TokenPolicy.ts`):

- `@Policy(TokenPolicy)` must sit at the **method** level. A class level
  declaration lands in the CONTROLLER policy scope, and the controller scope is
  ANDed with the route scope - it would then have to hold together with the
  `RbacPolicy` group that `@Permission` pushes on the route, and `RbacPolicy`
  demands an authorized session that a token request never has. Every token
  request would 401. Method level puts it in the same scope as `@Permission`,
  and groups within one scope are ORed: a token request satisfies the
  `TokenPolicy` group, a session request satisfies the `RbacPolicy` one.
- For the same reason it must not be passed as `@Permission`'s `also` argument -
  `@Permission(['readOwn'], TokenPolicy)` bundles both into a single ANDed group.
- Writing it **below** `@Permission` is deliberate: decorators apply bottom up,
  so when no group holds, the reported rejection is this policy's 403
  ("token role(s) ... do not have permission ...") instead of `RbacPolicy`'s
  misleading "user not logged" 401.
- Because the two route-scope groups are **ORed**, adding `@Policy(TokenPolicy)`
  *widens* the route: it becomes reachable by a token holder whose effective
  roles carry the grant **and** by a session holder whose active role carries
  it, exactly as before. It is not a "tokens only" switch. Use
  `NoTokenAuthPolicy` (below) for the opposite - a route sessions may use and
  tokens may not.
- The `@Permission` line stays required - `TokenPolicy` reads the same route
  permission metadata, and a route without it silently inherits the
  controller-level default `['readOwn']`.

Clients authenticate with `Authorization: Bearer spt_...` (scheme name is
case-insensitive) or the configured fallback header (`x-api-key` by default).

## Token semantics

- Effective roles at request time = token roles ∩ owner's current roles. Roles
  are re-intersected on every request, so a role revoked on the user takes
  effect immediately for all of their tokens.
- A token whose effective role set becomes empty stops authenticating.
- Permission checks run against the **whole** effective role set. A session has
  an *active role* it can switch at runtime (`POST /auth/active-role`) and is
  authorized by that one role; a token has no session and no way to switch, so
  it would be stuck with whichever role happened to be first. Instead
  `TokenAuthMiddleware` clears `req.storage.ActiveRole`, and every consumer
  (`checkRoutePermission`, the orm rbac query middleware) falls back to
  `User.Role` - already narrowed to the effective set.
- Owner deactivated / banned / soft-deleted => all their tokens stop working.
- `ExpiresAt` null/absent => token never expires.
- Plaintext shown exactly once at creation; only its SHA-256 hash is stored, and
  the hash itself is `@Hidden()` so it never reaches a response either.
- Session-authenticated requests ignore tokens: `TokenAuthMiddleware` runs after
  `RbacMiddleware` and bails out when a session is present, so a request never
  mixes both.
- Token-authenticated responses are sent with `Cache-Control: no-store`.
- Tokens cannot manage tokens - the management API is guarded by
  `NoTokenAuthPolicy` (no self-replication).
- Tokens cannot be minted or managed while impersonating another user -
  `NoImpersonationPolicy` (also exported) rejects such requests with 403. An
  impersonated session is supervised and revocable; a token it minted would
  outlive it, carry the victim's roles, and be invisible to them.
- A token always keeps at least one role - revoking the last one is refused
  (400 / `E_TOKEN_ROLE_NOT_ALLOWED`). Delete the token to revoke it entirely.
- A token can never carry a role the configured policy disallows for its
  owner, at creation or grant. The shipped default limits that to the owner's
  own roles - see [Token role policy](#token-role-policy).
- `LastUsedAt` is stamped on use, throttled to one write per
  `rbac.token.lastUsedUpdateInterval` seconds.

## Token role policy

`AccessTokenRolePolicy.allowedRoles(owner)` decides which roles an owner may
put on a token. There is exactly one method, but FOUR call sites -
`createToken`, `grantTokenRole`, `validateToken` and the `GET
user/tokens/roles` controller route (all through the shared `_allowed_roles`
helper in `src/actions.ts`) - share it deliberately: creation time and request
time have to agree on the same answer, or a role a user was allowed to pick
could be one their token silently loses (or gains) on the very next request.

**`owner` is only guaranteed to be a base `User` with `Metadata` populated -
nothing more.** `GET user/tokens/roles` and `createToken` (from `POST
user/tokens`) are handed `req.storage.User`, the application's `User`
subclass with whatever the request pipeline already hydrated onto it, while
`grantTokenRole` and `validateToken` are handed a base `User` loaded
independently of any application model override. A policy that reads a field
an application added to its own `User` subclass will see it on a
session-authenticated call and not on a token-authenticated one - implement
against base `User` + `Metadata` only.

The shipped default, `OwnRolesTokenRolePolicy`, answers with the owner's own
`Role` array. That is the behaviour this package had before the seam existed,
so an application that configures nothing sees no change.

To scope tokens more narrowly than "everything the owner can do" - or to allow
a token to carry a role that is not on the owner's `Role` list at all -
implement `AccessTokenRolePolicy`, decorate the class with
`@Injectable(AccessTokenRolePolicy)`, and name it in
`rbac.token.rolePolicy.service`, the same pattern
`rbac.token.generation.service` uses for the token generator.

Because `validateToken` re-asks the policy on every authenticated request
instead of trusting the roles stored on the token row, swapping in - or
tightening - a policy takes effect immediately on every existing token: there
is nothing to migrate or re-issue. `GET user/tokens/roles` exposes the same
answer to a caller before they create a token, from the same policy
`POST user/tokens` validates against, so a client is never offered a role that
creation would then refuse.

`rbac.token.excludedRoles` is a list of role-name patterns for a custom policy
to consult - it is not read by anything shipped in this package, including the
default policy. `_role_excluded(role, patterns)`, exported from
`src/role-policy.ts`, implements the matching: a pattern is either an exact
role name, or a name ending in `.*`, which matches that prefix and everything
beneath it - `route.*` matches `route.home` and `route.admin.users`, but not
`routes.read` (the dot is part of the boundary, so a pattern can never swallow
an unrelated role that merely starts with the same letters). No other
wildcard syntax is supported, on purpose - a full glob in a security list
invites patterns nobody can reason about.

## HTTP API (session auth required)

All routes live under the `user.tokens` resource and operate on the caller's own
tokens only - a foreign uuid simply reads as 404.

| Route | Description |
|---|---|
| `GET user/tokens/roles` | roles the caller may put on a token |
| `GET user/tokens` | list own tokens |
| `POST user/tokens` | create (`{ Name, Roles, ExpiresAt? }`), returns plaintext once |
| `DELETE user/tokens/:uuid` | revoke (delete) a token |
| `PUT user/tokens/:uuid/roles/:role` | grant role |
| `DELETE user/tokens/:uuid/roles/:role` | revoke role |

Responses: `400` for role refusals (role not allowed for the caller by the
configured role policy, last role revoke), `401` without a valid session,
`403` when the request is token-authenticated or impersonated, `404` for a
token the caller does not own.

## CLI

```
rbac:token-create <userIdOrUuid> -n <name> -r <roles> [-e <iso>]
rbac:token-delete <uuid>
rbac:token-grant <uuid> <role>
rbac:token-revoke <uuid> <role>
rbac:token-delete-expired   # run cyclically from a worker
```

- `-r, --roles` is a comma separated list, and must be allowed for the owner
  by the configured role policy (see [Token role policy](#token-role-policy)).
- `-e, --expires` takes an ISO instant. Omitting the flag entirely means the
  token never expires; an empty or unparsable value is refused rather than
  silently treated as "no expiration".
- `rbac:token-create` prints the plaintext once - it cannot be retrieved later.
- `rbac:token-delete-expired` is housekeeping only; expired tokens are already
  refused at authentication time.

## Configuration

**A consuming app MUST import the package in its bootstrap** -
`import '@spinajs/rbac-http-token';` - even when it uses nothing from it
directly. The model, the migration and the auth middleware register themselves
through decorators when their module is loaded, and the migration in particular
is *not* found by filesystem scan (see the comment on `system.dirs` in
`src/config/rbac-http-token.ts` and the note at the bottom of this file). Without
that import the `rbac_access_tokens` table is never created.

See `src/config/rbac-http-token.ts` - `rbac.token.*`:

| Key | Default | Meaning |
|---|---|---|
| `rbac.token.generation.service` | `SecureRandomTokenProvider` | `AccessTokenGenerationProvider` implementation used to generate/hash tokens |
| `rbac.token.rolePolicy.service` | `OwnRolesTokenRolePolicy` | `AccessTokenRolePolicy` implementation that decides which roles an owner may put on a token (see [Token role policy](#token-role-policy)) |
| `rbac.token.excludedRoles` | `[]` | role-name patterns (exact, or `prefix.*`) for a custom policy to consult - not read by the shipped default |
| `rbac.token.prefix` | `spt_` | stable plaintext prefix, lets secret scanners recognise leaked tokens |
| `rbac.token.length` | `32` | random bytes per token (32 = 256 bit entropy) |
| `rbac.token.headerName` | `x-api-key` | fallback header checked when no `Authorization: Bearer` is present |
| `rbac.token.lastUsedUpdateInterval` | `60` | seconds between `LastUsedAt` writes for a busy token |

The package also ships `rbac.grants` for the `user.tokens` resource and queue
routing that sends its events (`AccessTokenCreated`, `AccessTokenDeleted`,
`AccessTokenRoleGranted`, `AccessTokenRoleRevoked`) to rbac's empty connection
instead of the application's default broker.

`system.dirs` ships `cli` and `controllers` only - those are found by filesystem
scan. `migrations` is deliberately absent: a non-empty `system.dirs.migrations`
makes the orm replace its build-layout defaults, which would switch off
migration discovery in every consuming app. The initial migration carries
`@Migration`, is exported from the package index, and is picked up from the DI
registry instead.
