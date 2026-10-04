# @spinajs/authn-token

API tokens and JWT bearer authentication for SpinaJS 3.0, behind the
`@spinajs/authn` contracts.

## What it provides

- `DbTokenService`: the `TokenService` over the `rbac_access_tokens` table.
  Tokens are `spt_` + 32 random bytes (base64url); only their SHA-256 hash is
  stored, and the plaintext is returned once, at create. Every token has an
  expiry. Kinds: `pat`, `service` and `agent` (an agent acts for its owner,
  narrowed by its scope). `create` and `revoke` publish `token.create` and
  `token.revoke` to every `AuthnEventSink`; `validate` publishes nothing.
- `TokenStrategy`: the `AuthenticationStrategy` for API tokens. It checks the
  token, the owner's status (`IdentityStore.status`, on every use) and the
  profile, and stamps `LastUsedAt` at most once per
  `authn.token.lastUsedUpdateInterval`.
- `JwtBearerStrategy`: JWTs from the issuers in `authn.jwt.issuers`. It
  answers an external subject; `AuthnService` maps it to an identity through
  the identity links.
- The CLI: `authn:token-create`, `authn:token-delete` and
  `authn:token-delete-expired` (run it on a schedule).
- The migration `AuthnTokenScope_2026_10_02_00_00_00`: adds `Scope`, `Kind`,
  `RevokedAt` and `LastUsedIp`, and gives 2.x tokens without an expiry one of
  `CreatedAt + authn.token.maxTtlDays`.

Import the package in the app's bootstrap (`import '@spinajs/authn-token';`).
The model, the migrations and both strategies register themselves when the
module loads; the migrations are not found by a scan of `system.dirs`.

## Bearer dispatch

Both strategies take credentials of kind `bearer`. Each one answers only for
its own format: `TokenStrategy` for values with the token prefix,
`JwtBearerStrategy` for compact JWTs while issuers are configured. A value in
another format gets `unsupported_credentials` from `verify` and `[]` from
`throttleKeys`, with no I/O, so the dispatch passes it on to the other one.

## Configuration

| Key                                  | Default                     | Meaning                                                                                                                                                                       |
| ------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authn.token.prefix`                 | `spt_`                      | Plaintext prefix; lets secret scanners find leaked tokens. Empty fails boot.                                                                                                  |
| `authn.token.length`                 | `32`                        | Random bytes per token. Below 32 fails boot.                                                                                                                                  |
| `authn.token.maxTtlDays`             | `90`                        | Longest expiry of a `pat` or `service` token.                                                                                                                                 |
| `authn.token.defaultTtlDays`         | `30`                        | Expiry a client (route, CLI) proposes when the caller gives none.                                                                                                             |
| `authn.token.agentMaxTtlMinutes`     | `1440`                      | Longest expiry of an agent token.                                                                                                                                             |
| `authn.token.headerName`             | `x-api-key`                 | Header authn-http reads a token from besides `Authorization: Bearer`.                                                                                                         |
| `authn.token.lastUsedUpdateInterval` | `60`                        | Seconds between `LastUsedAt` writes for a busy token.                                                                                                                         |
| `authn.token.generation.service`     | `SecureRandomTokenProvider` | The `AccessTokenGenerationProvider` that mints and hashes tokens.                                                                                                             |
| `authn.jwt.issuers`                  | `[]`                        | Trusted issuers: `{ issuer, audience, jwksUri \| keys, algorithms, clockSkewSeconds? (30), subjectClaim? ('sub'), provider? ('jwt:<issuer>'), linking? ({ jit: false }) }`. An unlinked subject is provisioned only when both `linking.jit` here and `authn.linking.jit` are on; a bearer JWT never links by email. An invalid entry fails boot. |

## Hooks

- `TokenOwnerResolver` maps an owner (`IdentityRef`) to the
  `rbac_access_tokens.user_id` row id and back. The default,
  `UsersTableTokenOwnerResolver`, reads `users.Id` and `users.Uuid` and
  supports owners of type `user` only.
- `TokenProfilePolicy` lists the profiles an owner may pin a token to. It is
  asked at create (`invalid_scope` when not allowed) and on every validate (a
  token whose profile is no longer allowed fails). The default,
  `NoTokenProfilesPolicy`, allows none. The profile reaches the principal as
  `attributes.profile`.
- `RoleSource` (optional): when one is registered, `create` refuses a role the
  owner does not hold with `invalid_scope`. Without one, roles are stored as
  given.

## Token roles (B24, B07)

A token's roles only narrow its owner's rights; they never add to them. The
roles reach the principal as `ceiling.roles`, never as identity roles, and
authz-rbac keeps only the owner's assignments of the roles listed in
`ceiling.roles`. That check-time rule is the authoritative one; the
`RoleSource` refusal at create is defence in depth. `roles: []` is refused at
create (a token that grants nothing); no roles means no role ceiling.

## 2.x API

The 2.x token API under `src/legacy/` (`createToken`, `validateToken`,
`touchToken`, `AccessTokenRolePolicy`, the 2.x events and exceptions, and the
rest) is still exported for `@spinajs/authn-http`. It is deprecated: use
`TokenService`. R1 removes it.
