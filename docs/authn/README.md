# Authentication in SpinaJS 3.0

`@spinajs/authn` answers one question: who is calling, and how sure are we? Its result is a
`Principal` that authorization uses. It replaces the 2.x login, session, password, 2FA, token and
impersonation code that lived in `@spinajs/rbac*`.

- Moving a 2.x app: read [the migration guide](../authz/migration-guide.md). Its authn parts are
  [config](../authz/migration-guide.md#32-authentication-keys),
  [data migration](../authz/migration-guide.md#7-data-migration),
  [steps 6 to 9](../authz/migration-guide.md#8-steps-for-an-app) and
  [lane notes](../authz/migration-guide.md#9-behaviour-changes-lane-by-lane).
- Authorization (what the caller may do): [docs/authz](../authz/README.md).
- OIDC single sign-on: [oidc.md](./oidc.md).
- Rule numbers (A05, SR-03, H31) point to the design: `docs/plans/2026-10-01-authz-v3-design.md`
  (§22.17 for A-rules, §23 for the SR findings).

This page describes `3.0.0-rc.1`. Open items are listed in
[the migration guide, section 11](../authz/migration-guide.md#11-open-items-in-300-rc1).

## Contents

- [Boundaries and packages](#boundaries-and-packages)
- [How a login runs](#how-a-login-runs)
- [Strategies](#strategies)
- [Sessions](#sessions)
- [MFA](#mfa)
- [Tokens](#tokens)
- [Keys](#keys)
- [Throttling](#throttling)
- [Audit and events](#audit-and-events)
- [Impersonation](#impersonation)
- [Package set per app type](#package-set-per-app-type)
- [Config `authn.*`](#config-authn)
- [Testing](#testing)

## Boundaries and packages

Three families, one direction:

| Family | Config root | Answers |
|---|---|---|
| Identity (`@spinajs/users*`) | `users.*` | Who exists: user records, profile, lifecycle, lifecycle mails. |
| Authentication (`@spinajs/authn*`) | `authn.*` | Who is calling and how sure we are: credentials, sessions, MFA, tokens, keys, throttling, audit, impersonation. |
| Authorization (`@spinajs/authz*`) | `authz.*` | What that caller may do. |

`authn*` never imports `authz*` or `users*`. `authz` imports only the principal types from
`@spinajs/authn/contracts`. `authn-http`'s `AuthnMiddleware` hands its result to `authz-http` through
`req.storage.AuthnPrincipal`. `users` implements the pieces that need both (D26).

`users` plugs into authn through `IdentityStore` (find a login, read the status) and
`PasswordCredentialStore` (the hash in `users.Password`). Anything in authn that needs authz is a hook
that `users` implements: `ImpersonationGuard`, `AuthnResponseExtension` (users' `AccessResponseExtension`
adds `Access` to answers) and `RoleSource` (the roles for a role switch).

users registers them when the app imports it: `UserIdentityStore`, `UserPasswordStore`,
`UserPrincipalFactory`, `UserPasswordAgeSource`, `AuthzImpersonationGuard`, `AccessResponseExtension`,
`RbacRoleSource` and `AuthzCredentialAdminGuard` (the `CredentialAdminGuard` of the admin routes).
**Import `@spinajs/users` in the app entry:** no authn package depends on it, and without it
`AuthnService` fails its boot check for the missing `IdentityStore`.

| Package | Holds |
|---|---|
| `@spinajs/authn` | Contracts (the `contracts` subpath loads no service module), `AuthnService`, strategy registry, `MfaPolicy`, throttle engine, audit fan-out, config schema. |
| `@spinajs/authn-orm` | Tables and stores: links, throttle, audit, single-use secrets, MFA, recovery codes, nonces; the 2.x data migration. |
| `@spinajs/authn-session` | Session issuer, cookie, expiration strategies, hashed ids, pending (pre-MFA) state. |
| `session-provider-db`, `-redis`, `-dynamodb` | Session stores on the `authn-session` contract. |
| `@spinajs/authn-local` | Password strategy, argon2 hasher, policy, change, reset, invite, expiry, CLI. |
| `@spinajs/authn-totp` | TOTP and recovery codes. |
| `@spinajs/authn-token` | API tokens, agent tokens, JWT bearer, token CLI. |
| `@spinajs/authn-keys` | Public keys, strict JWS, client assertions, HTTP signatures, challenge login. |
| `@spinajs/authn-oidc` | OIDC and OAuth2 client with presets. |
| `@spinajs/authn-http` | Middleware, credential extractors, CSRF origin guard, policies, routes, `authn:check-config`. |
| `@spinajs/authn-testing` | Fakes, conformance suites and the behaviour rules A01-A32. |

## How a login runs

The design fixes the order of `AuthnService.authenticate(credentials, ctx)` (§22.4):

1. Pick the candidates: the strategies in `authn.strategies` that accept the credential kind and,
   when a strategy has `accepts(credentials)`, the credential itself. None: failure
   `unsupported_credentials`. A strategy that is not listed never runs (A01).
2. Ask the throttle. When any candidate is interactive (password, MFA), or the throttle has no `peek`,
   count the attempt before verification: the throttle keys of all candidates are counted once, as a
   union. When every candidate is a per-request strategy (token, key, signature) and the throttle has
   `peek`, only read the throttle now and count after a failure (K5). A refused attempt is neither
   verified nor counted. The answer carries `Retry-After` (A05, A06).
3. The first candidate verifies. It takes the same time for an unknown account as for a known one
   (A02). Only an `unsupported_credentials` answer passes the credential to the next candidate. Two
   strategies of one kind, such as `token` and `jwt` (both `bearer`), rely on this: a value in the
   other format gets `unsupported_credentials` with no I/O. Nothing checks at boot that one strategy
   shadows another.
4. Map the result to an identity: directly, through `authn_identity` (an external subject), by a
   verified email, or by JIT provisioning. Email matching needs `authn.linking.byVerifiedEmail`, the
   provider's verified flag, **and** an email that the identity store itself holds for the identity.
   JIT needs `authn.linking.jit`. Otherwise `not_linked`.
5. Check the identity status: inactive, banned and deleted are a failure. The core asks for every
   subject except `service` and `agent`, which their strategies vouch for. Only `user` identities get
   sessions. The caller sees one answer for every failure: HTTP 401 `E_AUTH_FAILED`. The real reason
   goes to audit only (A02).
6. For an interactive strategy: ask the `MfaPolicy`. A refusal (an enrolled step the list lacks, a
   failing source) is a failure and keeps the throttle count (Z8). Otherwise reset the account throttle
   key; a success removes only that account's attempts from the IP key.
7. Steps required means a *pending* session and an `mfa_required` result. Otherwise issue a session.
   A per-request strategy (token, key, signature) resets its throttle key and returns a result with no
   session.

`completeMfa(pending, step, response, ctx)` counts into the `mfa` throttle and asks the policy again for the
required steps of the pending session. Passing any one of them, or a recovery code, elevates the
session to `aal2`, with a new session id (A07). An account banned or deleted between the two steps gets
no session.

`DefaultAuthnService` is the core service. It is created once per container, so a child container
reads its own `authn.strategies`. The result becomes a `Principal` through `PrincipalFactory`, with
`authn` facts: `method`, `strategy`, `assurance` (`aal1` or `aal2`), `mfa` steps passed,
`authenticatedAt`, `impersonator` and `sessionHandle`. Authorization conditions can read
`principal.authn.*` (A23).

**Strategy registry.** `StrategyRegistry` reads `authn.strategies` as `{ name, service }` entries in
list order, and finds each service among the registered `AuthenticationStrategy` classes by class
name (a child container also sees its ancestors'). Boot fails on a service that is not registered, a
duplicate name, an entry name that differs from the strategy's own `name`, and a strategy with no
boolean `interactive` or no credential kind. Registered but unlisted strategies never run. An exact
repeat of one entry in two config files is dropped.

**`DefaultMfaPolicy`.** It returns the steps of `authn.mfa.steps` that the identity is enrolled in, for
password logins only. When none is enrolled, `force`, or a role from `forceForRoles` (asked through
`RoleSource`), requires the first configured step, so the pending session can only enrol. Boot fails
when `force` or `forceForRoles` has no step to require, and when `forceForRoles` has no `RoleSource` or
`PrincipalFactory`. When the identity is enrolled in no listed step, the policy asks the
`MfaEnrolments` sources (`@spinajs/authn/mfa-enrolments`; authn-orm's `DbMfaEnrolments` reads
`authn_mfa`): a confirmed enrolment in a step the list lacks refuses the password login
(`mfa_step_not_listed`), and so does one a listed step does not see (`mfa_enrolment_mismatch`), with
or without `force`. The client gets the wrong-password answer, no session is made, and the throttle
keeps the count. A source that throws refuses the login. With no source registered (authn-orm not
loaded in the process), nothing is checked. `authn:check-config` names each enrolled step the list
lacks; it cannot see a mismatch.

A step that stores secrets declares `storesSecrets: true`. That works today: outside development and
test, boot then refuses a missing `authn.mfa.encryptionKey`; in development and test it only warns.

Boot checks and `authn:check-config` are in
[the migration guide](../authz/migration-guide.md#34-keys-that-other-config-files-own). The
command ships in `authn-http`; the check behind it is the function `checkAuthnConfig`.

## Strategies

A strategy is an `AuthenticationStrategy` with a name, the credential kinds it accepts, and whether it
may start a session (`interactive`). You list the ones you want in `authn.strategies`:

```ts
authn: {
  strategies: [
    { name: 'local', service: 'LocalPasswordStrategy' },
    { name: 'token', service: 'TokenStrategy' },
    // { name: 'jwt', service: 'JwtBearerStrategy' },
    // { name: 'keys-jws', service: 'JwsAssertionStrategy' },
    // { name: 'keys-httpsig', service: 'HttpSignatureStrategy' },
    // { name: 'keys-challenge', service: 'KeyChallengeStrategy' },
  ],
}
```

| Strategy | Credential | Session | Package |
|---|---|---|---|
| `local` (`LocalPasswordStrategy`) | `password` | yes | `authn-local` |
| `token` (`TokenStrategy`) | `bearer` (`spt_…`, or the `x-api-key` header) | no | `authn-token` |
| `jwt` (`JwtBearerStrategy`) | `bearer` (a compact JWT) | no | `authn-token` |
| `keys-jws` (`JwsAssertionStrategy`) | `jws-assertion` | no | `authn-keys` |
| `keys-httpsig` (`HttpSignatureStrategy`) | `http-signature` | no | `authn-keys` |
| `keys-challenge` (`KeyChallengeStrategy`) | `key-challenge` | yes | `authn-keys` |
| `oidc:<name>` | `external` | yes | `authn-oidc` ([oidc.md](./oidc.md)) |

### Local password

`LocalPasswordStrategy` looks the account up through `IdentityStore.findByLogin`. For an unknown login
it verifies against a dummy hash made at boot with the same parameters, so the timing is equal (A02).

- **Hash:** argon2id at the argon2 library defaults (64 MiB, t=3, p=4). No config key sets the cost
  (H30). A test pins the stored prefix `$argon2id$v=19$m=65536,t=3,p=4$`, so an upgrade of argon2 that
  changes the defaults fails CI. At most `authn.local.hasher.maxConcurrent` hashes run at once
  (default 8). Peak memory is that number times 64 MiB. Small hosts lower `maxConcurrent`, not the
  cost.
- **Pepper (optional):** `HMAC-SHA256(pepper, password)` before argon2. The version is stored in the
  hash (`$sp<version>$…`). To rotate, move the old `{ secret, version }` into `pepper.previous`. Old
  hashes still verify and are rehashed on the next login. `secret` is a secret reference, never an
  inline value.
- **Rehash:** a login rehashes a hash whose parameters or pepper version are old. The write is a
  compare-and-set, so it never overwrites a concurrent change or reset.
- **Policy:** passwords are never trimmed. Length is 8-128 code points on create, change, reset and
  login. Add `policy.rule` (a JSON schema) and a `PasswordBlocklist` service named in
  `policy.blocklist` (for example a breach check) (A04).
- **Change (`PasswordService.change`):** needs the owner's own active session (not one that someone
  impersonates). It keeps every API and agent token (H32, A30), revokes the identity's other sessions,
  including sessions where it is the impersonator, and rotates the current one. The write is a
  compare-and-set against the hash that the old password matched. When another write got there first
  (a rehash, a reset, another change), the change answers `invalid`, audits the failure with the
  reason `stale`, and neither revokes nor rotates any session. It does not retry.
- **Reset and invite:** `requestReset` answers at once with the same body whether or not the account
  exists, and issues a single-use secret through `SecretStore`. `redeemReset` is single use, revokes
  all sessions and, with `reset.revokeTokens` (default true), all API tokens. It accepts a secret of
  purpose `reset`, or `invite` while the identity has a pending invite. A secret mailed before the
  upgrade keeps working once (A32). The mail is rendered and sent when the secret is issued; the queue
  never holds the secret (`PasswordMailer`).
- **Expiry:** off by default (`authn.local.expiration.enabled: false`, `maxAgeDays: 31`). An expired
  password is stored as the marker `!expired`, and the old password no longer logs in.
- **CLI:** `authn:password <login>` (the password from `--generate` or standard input, never from an
  argument) and `authn:password-expire`.

### Token and JWT

See [Tokens](#tokens). Both strategies take credentials of kind `bearer`. A value in another format gets
`unsupported_credentials` and no throttle keys, with no I/O, so the dispatch passes it on.

### Key strategies

See [Keys](#keys).

### OIDC

See [oidc.md](./oidc.md).

## Sessions

`authn-session` issues sessions. The store is chosen by `authn.session.service`: `MemorySessionStore`
(one instance, for tests), `DbSessionStore` (MySQL, PostgreSQL, SQLite), `RedisSessionStore` (one
Redis, not Cluster) or `DynamoDbSessionProvider`.

- **Ids:** 128 bits from a CSPRNG, base64url. Stores keep `sha256(id)` only. A session never holds the
  raw id (SR-18). A 2.x session is found by its raw id (a UUID v4) on its first request and re-saved
  under the hash, so an upgrade does not log users out.
- **Rotation:** the id changes on login, MFA completion, role switch, and impersonation start and
  end (A07).
- **Expiry:** `authn.session.expiration`: `AbsoluteExpiration`, `SlidingExpiration` or
  `SlidingCappedExpiration` (idle `ttl` 30 minutes, `maxLifetime` 480 minutes by default).
- **States:** `active`, and `pending` (after the password, before MFA). A pending session lives
  `pendingTtlSeconds` (300), is never extended, yields **no principal** (authorization sees an
  anonymous caller) and accepts only MFA routes (A09, D25).
- **Revoke:** `revokeAll(subject, { except?, includeImpersonations? })` ends every session of an
  identity, and with `includeImpersonations` the sessions where it is the impersonator. A ban, a
  deactivation, a reset and a password change call it (A08).
- **Listing:** `list(subject)` shows hashed handles, creation and last-seen times, IP and user
  agent. The subject may revoke a session by its handle, including one in which someone impersonates
  it. A 3.0 row has a null `UserId`, so deleting a user must call `revokeAll`.
- **Cookie:**

```ts
authn: {
  session: {
    service: 'DbSessionStore',
    expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 },   // minutes
    pendingTtlSeconds: 300,
    cookie: { name: 'ssid', hostPrefix: 'auto', secure: 'auto', sameSite: 'strict' },
  },
}
```

  `HttpOnly` always. `'auto'` means `Secure` and the `__Host-` prefix are on unless the app env is
  development or test, so the cookie is named `__Host-ssid`. For local http, name the env
  (`APP_ENV=development`): `secure: false` alone no longer relaxes the cookie, and `hostPrefix: false`
  alone keeps `Secure` outside development and test. The
  cookie is signed with `http.cookie.secret`, which must not be the public default outside development
  and test (A24).

  **With no app env set, authn treats the deployment as production** (SR-16). The configuration still
  falls back to `development` when `--env`, `APP_ENV` and `NODE_ENV` are all missing, but the authn
  core, the cookie builders and `authn-oidc` read that as "no env"
  (`packages/authn/src/service/boot/env.ts`): the cookie is `Secure` and `__Host-` prefixed, and the
  public cookie secret fails boot. Only an env source that names development or test relaxes them.
  Set `APP_ENV` or `NODE_ENV` explicitly in every deployment; the core warns when it fell back.

  The cookie is a browser-session cookie (no `Max-Age`); idle and absolute timeouts are enforced on the
  server. `authn-http` issues, rotates and clears it on its routes and stores the client IP and user
  agent with the session.

## MFA

TOTP is the 3.0 second factor. The design fixes (§22.8):

- Secrets are stored encrypted with AES-256-GCM under `authn.mfa.encryptionKey` (`authn_mfa`). The key
  id is stored with the cipher text, so the key can rotate.
- The last accepted time step is stored, so a code works once (A10, SR-15).
- Ten recovery codes at enrolment, stored as SHA-256 and single use. A recovery code enters as
  `completeMfa(pending, 'recovery', code, ctx)`, so no step may be named `recovery`.
- Enrolment needs fresh auth. Disabling needs fresh auth and a valid code or recovery code. An admin
  can reset MFA but never receives a secret.
- `authn.mfa.policy`: MFA is required when the identity is enrolled. `force: true` makes enrolment
  part of the first login, and the pending session may call only the enrol and confirm routes.
  `forceForRoles` asks for roles through `RoleSource`.

Packages ship no step. This is what an app that uses TOTP sets:

```ts
authn: {
  mfa: {
    policy: { service: 'DefaultMfaPolicy', force: false, forceForRoles: [] },
    steps: [{ name: 'totp', service: 'TotpMfaStep' }],
    encryptionKey: { secret: null },   // a secret reference; boot requires it outside development and test when a step stores secrets
    totp: { issuer: 'SpinaJS', algorithm: 'SHA1', digits: 6, period: 30, window: 1, recoveryCodes: 10 },
  },
}
```

`authn-orm` already holds the storage (`DbMfaStore`, the cipher, the recovery-code table). Recovery codes
there are unsalted SHA-256, so a step must generate codes of at least 80 bits.

### The TOTP step (`authn-totp`)

`TotpMfaStep` (`name: 'totp'`, `storesSecrets: true`) is the `MfaStep` for authenticator apps. It is
off until the app turns it on, because arrays concatenate across config files and a step the package
listed could not be removed:

1. List `{ name: 'totp', service: 'TotpMfaStep' }` in your own `authn.mfa.steps`.
2. Set `authn.mfa.encryptionKey.secret`: 32 random bytes as 64 hex characters, or as base64 or
   base64url. On rotation, move the old key to `authn.mfa.encryptionKey.previous` (a list). A row
   stores the id of the key that wrote it, so old rows still decrypt. A row whose key is gone is a
   server error, never a wrong code. The package ships no default for the key.
3. Import `@spinajs/authn-totp/db` once. It registers `DbMfaSecretStore` as the `MfaSecretStore`, over
   `authn-orm`'s `DbMfaStore` (`authn_mfa`, `authn_recovery_code`). Without it, or another registered
   `MfaSecretStore`, the step fails on first use with an error that names `MfaSecretStore`.

The import loads `authn-orm`, with its migrations and stores. The data migration moves 2.x TOTP
secrets into `authn_mfa` and deletes the 2.x `2fa:*`, `user:2fa:*`, `user:login:*` and
`user:pwd_reset:*` metadata, so import it only after the app has left the 2.x login. The root entry
of the package loads none of this: it takes only the cipher from `@spinajs/authn-orm/cipher`.

How the step behaves:

- **Codes.** RFC 6238 on `otpauth`. `verify` accepts a code once: it stores the last accepted time
  step and refuses that step and every older one (A10, SR-15). The code must be exactly `digits`
  digits, spaces allowed.
- **Secrets.** 20 random bytes, stored AES-256-GCM encrypted with the key id (SR-09). `begin` and
  `confirm` are race-safe: a conditional write never overwrites a confirmed row.
- **Recovery codes.** `authn.mfa.totp.recoveryCodes` (default 10, at most 100) codes of 80 bits,
  shown as `XXXX-XXXX-XXXX-XXXX` (16 base32 characters), stored as SHA-256 only, single use, returned
  once at confirmation or regeneration. Case and dashes do not matter on entry.
- **Options.** `authn.mfa.totp`: `issuer` (default `SpinaJS`; set your app name), `algorithm`
  (`SHA1`, `SHA256` or `SHA512`), `digits`, `period` (at most 300 s), `window` (at most 10 steps on
  each side) and `recoveryCodes`. A value out of range fails with `InvalidOption`.

`TotpService` is the owner's side: `begin`, `confirm`, `disable`, `regenerateRecoveryCodes` and
`adminReset`. Each call returns a result object (`{ ok: true, ... }` or `{ ok: false, code }`) and
throws only for a fault. Rules:

- The identity always comes from the restored session, never from the caller. An impersonated
  session is refused.
- `begin`, `disable` and `regenerateRecoveryCodes` need fresh auth (A13), with an optional inline
  `reauth` credential. `disable` also needs a TOTP or recovery code.
- A pending session (forced first login) may only `begin` and `confirm`, and only while the identity
  is enrolled in no MFA step. The login accepts any enrolled step, so a second factor added from a
  password-only session would pass it.
- `confirm` and `disable` count into the `mfa` throttle before the code is checked, under the keys
  that `completeMfa` uses, so enrolment and login share one budget. A refusal is
  `throttled` with `retryAfterSeconds`.
- Events go to the audit sinks as `mfa.enrol` and `mfa.disable`. Regeneration is an `mfa.enrol`
  event with `data.recoveryCodes = 'regenerated'`. No event carries a secret or a code.
- `adminReset(actor, target, ctx)` removes the enrolment and recovery codes and returns
  `{ reset }`, never a secret (SR-10). It does not check who may reset whom: the caller applies the
  target guard (A25, `users:credentials`) first.
- `TotpService` finds the other MFA steps in the root container. An app that registers steps per
  child container passes `steps` itself.

**CLI:** `authn:mfa-reset <login>` removes the enrolment and recovery codes of an account and prints no
secret. It replaces `rbac:user-enable-2fa`, which handed a secret to the operator and is gone.
`rbac:2fa-qr` (a QR code for a secret or an otpauth URL) is unchanged.

**Legacy keys.** `authn-totp` ships no `rbac.twoFactorAuth.*` and no `rbac.otpauth.*` key, so the
legacy-key detector (on by default) passes on its config. The 2.x 2FA code and routes are gone; an
app that still sets `rbac.twoFactorAuth.*` fails boot until it moves the keys.

## Tokens

`authn-token` holds personal, service and agent tokens (SR-08, A14, A15).

- **Format:** `spt_` plus 32 random bytes (base64url). Only the SHA-256 hash is stored, and the
  plaintext is returned once at creation and never logged. The table is `rbac_access_tokens`
  (name kept), with new columns `Scope`, `Kind`, `RevokedAt` and `LastUsedIp`.
- **Expiry is mandatory.** At most `maxTtlDays` (90) for `pat` and `service`; agent tokens at most
  `agentMaxTtlMinutes` (1440). Each use checks expiry, revocation, the owner's status and the profile.
- **Roles only narrow.** A token's roles reach the principal as `ceiling.roles`. A role the owner
  lacks grants nothing (B24, B07).
- **Agent tokens** (`kind: 'agent'`) yield an `agent` principal with `onBehalfOf` the owner,
  `delegation: 'inherit'` and a ceiling with reason `out_of_scope`. They carry no roles.
- **Profile:** the 2.x token `Profile` stays. It travels as `attributes.profile`, and
  `TokenProfilePolicy` (default: none allowed) lists the profiles an owner may pin.
- **JWT bearer** (`authn.jwt.issuers`): an allow-list of issuers with an algorithm list each (never
  `none`, never HMAC with a public key), the audience, a clock skew of at most 60 s, and a JWKS that is
  refreshed on an unknown `kid` at most once a minute. The subject maps to an identity through
  `authn_identity`, provider `jwt:<issuer>`.
- **CLI:** `authn:token-create`, `authn:token-delete`, `authn:token-delete-expired`.

```ts
authn: {
  token: { prefix: 'spt_', length: 32, maxTtlDays: 90, defaultTtlDays: 30, agentMaxTtlMinutes: 1440,
           headerName: 'x-api-key', lastUsedUpdateInterval: 60 },
  jwt: { issuers: [] },   // [{ issuer, audience, jwksUri | keys, algorithms, clockSkewSeconds?, subjectClaim?, provider? }]
}
```

A length below 32 or an empty prefix fails boot. The full table is in `packages/authn-token/README.md`.

**Routes** (`authn-http`, on while a `TokenService` is registered): `GET /user/tokens` lists the
caller's tokens that are not revoked, expired ones flagged; `POST /user/tokens` needs `expiresAt` and fresh auth and answers the plaintext
once; `DELETE /user/tokens/:uuid` revokes and keeps the row. A token or key caller gets 403
`session_required`, an impersonating session 403 `impersonating`. `users-http` serves
`GET /user/tokens/roles` and `GET /user/tokens/profiles`, the roles and profiles a new token may
carry.

## Keys

`authn-keys` lets a machine client or a CLI prove who it is with a public key. It shares its JWS rules with
the canvas realtime tickets (C8).

- **Keys:** Ed25519 and ECDSA P-256 public JWKs only. The algorithm is fixed on the key record and
  never read from a token. A `kid` is 1-64 of `[A-Za-z0-9._-]`. The owner is a user, a service or an
  agent. A key may carry a `scope` ceiling, an expiry and a revocation (A17).
- **Register:** a user registers a key through `POST /user/keys`, with fresh auth and a signature over
  a `register` challenge (proof of possession); `GET /user/keys` lists them and
  `DELETE /user/keys/:kid` revokes one. Services and runners are registered by the CLI
  (`authn:key-add`, `authn:key-list`, `authn:key-revoke`); there is no admin route for keys.
  `authn:key-add` refuses a user owner and points to `POST /user/keys`.
- **JWS client assertion** (`keys-jws`): `Authorization: Bearer <jws>`, header exactly
  `{ alg, kid, typ: 'spinajs-client+jwt' }`, claims `iss` (`user:<uuid>` or `service:<id>`), `aud`
  (`authn.keys.assertion.audience`, required), `iat`, `exp` (lifetime at most 300 s) and a single-use
  `jti`.
- **HTTP signature** (`keys-httpsig`): an RFC 9421 subset with one signature that covers `@method`,
  `@target-uri` and, with a body, `content-digest`, and carries `created`, `expires` (at most 300 s
  ahead), `nonce` and `keyid`. Build `targetUri` from the configured public origin, never from `Host`: `authn-http` checks it
  against `authn.http.publicOrigin`, and without that key a signed request yields no principal.
- **Challenge login** (`keys-challenge`): `POST /auth/keys/challenge`, then `POST /auth/keys/login` with
  a signature over `spinajs-key-<purpose>:<nonce>:<audience>`. A throttled challenge answers 429 with
  `Retry-After`. A key login is `aal1` and asks no MFA step under the default MFA policy.
- **Canvas parity:** `LocalJwsSigner` writes tickets byte for byte as the canvas golden fixtures do,
  and the verifier reports the same error codes.

The formats, the OpenSSL recipe and every `authn.keys.*` key are in `packages/authn-keys/README.md`.

The key routes are on while a `KeyRegistry` is registered and `authn.keys.assertion.audience` or
`authn.keys.challenge.audience` is set. `authn-http`'s bearer extractor tells a `jws-assertion` from a
JWT by the JWS header `typ` (`authn.keys.assertion.typ`). Revoking a key does not end the sessions it
logged in.

## Throttling

3.0 never locks an account (H31). It backs off. The rule (A05, A06, §22.13):

- Default keys are `account` (the normalised login, known or not) and `ip` (from the trusted-proxy
  chain only). `account-ip` is kept for bookkeeping and gates nothing.
- After counted attempt `n` on a key, the next attempt waits `0` while `n < free`, and
  `min(baseDelayMs × 2^(n − free), maxDelayMs)` once `n ≥ free`. So `free` attempts run with no wait,
  and the wait after attempt number `free` is `baseDelayMs`.
- An interactive attempt (password, MFA) is counted before it is verified, with one compare-and-set per key. Of N parallel attempts
  on a fresh key, exactly `free` are verified, then one per delay slot. A per-request attempt only
  reads the throttle first and counts after a failure (see below).
- A refused attempt is not verified and not counted. It gets the opaque failure plus `Retry-After`,
  the same for known and unknown logins. The server never sleeps.
- A success resets the account key and subtracts that account's attempts from the IP key. A login to
  your own account cannot clear failures spent on other accounts.
- A key with no counted attempt for `resetAfterSeconds` starts from zero. The cap means the owner
  waits at most `maxDelayMs` (60 s for `login.account`), however many failures others cause.

```ts
authn: {
  throttle: {
    service: 'DbAuthnThrottle',                       // 'MemoryAuthnThrottle' for one instance
    login:  { account: { free: 5, baseDelayMs: 1000, maxDelayMs: 60000 },
              ip:      { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 } },
    mfa:    { account: { free: 3, baseDelayMs: 1000, maxDelayMs: 300000 },
              ip:      { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 } },
    reset:  { account: { free: 1, baseDelayMs: 60000, maxDelayMs: 3600000 },
              ip:      { free: 5, baseDelayMs: 10000, maxDelayMs: 900000 } },
    reauth: { account: { free: 3, baseDelayMs: 1000, maxDelayMs: 300000 } },
    resetAfterSeconds: 86400,
    global: null,
  },
}
```

Set `http.trustProxy` (a hop count, or addresses and CIDRs) when the app runs behind a proxy.
`authn-http`'s `ClientIp` writes `req.storage.ClientIp` from the proxy chain (`authn.http.trustProxy`,
else `http.trustProxy`); a client-set `X-Forwarded-For` without a trusted hop is ignored.

`DbAuthnThrottle` keeps keyed hashes of the keys
(`authn.audit.hashKey.secret`). Per-request credentials (tokens, keys) use the `login` flow under a
stable credential id, but count failures only: the service asks the throttle whether a delay holds
(`peek`, one read, no write), verifies, and writes only after a failure (K5). A throttle without `peek`
falls back to counting before verify, and the boot warns. Sub-second delays are not
supported on MySQL and MSSQL (their `datetime` is coarser).

`MemoryAuthnThrottle` is the throttle of one process. It keeps one table per flow, capped by
`authn.throttle.maxRows` (1,000,000 when unset; memory grows with 4 × `maxRows`). When a table is
full it evicts in two tiers and never drops a row that still delays someone. An app with several
instances uses `DbAuthnThrottle`, which needs `authn.audit.hashKey.secret` outside development and
test (boot fails without it; in development and test it keys rows with a random key per process). With
`authn.throttle.service` unset, the core takes the only
registered throttle, or the only one besides `MemoryAuthnThrottle`, so importing `authn-orm` is enough
(K6). A named throttle that is not registered fails boot, and so does an unset key when two throttles
besides the memory one are registered ("several are registered; name one"). Boot never falls back to
memory, which would count each instance apart. The service builds the `account-ip` key itself from the
account and the IP and ignores the one a strategy sends.

**Per-request strategies (K5, K6).** Parallel calls with a valid token or key all verify; failures still
back off per credential and per IP. Peek and count are two steps, so a parallel burst of failures is
verified in full before the backoff applies; this is safe only for unguessable credentials, which is
why per-request strategies take only tokens and signatures. The account key of a per-request
credential is `request:<credential id>|<ip>`, so whoever knows a key id can slow that key only from
their own address.

## Audit and events

Every `AuthnEvent` goes to every `AuthnEventSink` (A21). The event types are `login`, `logout`,
`mfa.*`, `reauth`, `session.*`, `password.*`, `invite.redeem`, `token.*`, `key.*`, `identity.*`,
`impersonation.*` and `throttle.block`. Events never carry passwords, tokens, secrets or raw session
ids. `LogAuthnAuditSink` writes identifiers as keyed hashes (SR-19). `DbAuthnAuditSink` does not hash:
its rows hold the raw subject refs, the IP and the user agent.

- `AuthnAudit` gives each event to every registered sink, one at a time, each bounded by
  `authn.audit.sinkTimeoutMs` (default 2000). A sink that fails or times out is logged by error class
  and never fails a login. The sinks are every `AuthnEventSink` registered in the container and its
  ancestors, in registration order; there is no list to keep. `authn-orm` registers `DbAuthnAuditSink`
  (table `authn_audit`). With no sink at all, boot logs a warning. Token and key *use* is sampled (`authn.audit.sampleUse`,
  default 0.01).
- `users`' `QueueAuthnEventSink` re-emits the 2.x queue events `UserLogged`, `UserLoginFailed`,
  `UserPasswordChanged`, `UserPasswordExpired`, `UserPasswordChangeRequest`,
  `UserImpersonationStarted` and `UserImpersonationEnded`, so 2.x subscribers keep working. The 2.x
  2FA events (`User2FaEnabled`, …) are gone: read `mfa.enrol` and `mfa.disable` in a sink.
- The DB sink never fails on event content: an identity that does not fit the column goes into `data`.

```ts
authn: { audit: { sampleUse: 0.01, hashIdentifiers: true, sinkTimeoutMs: 2000, hashKey: { secret: null } } }
```

## Impersonation

Who may impersonate whom is an authorization question. How impersonation works is an authentication
one.

- **Who (authz):** `AuthzImpersonationGuard` in `users` implements B26. The caller needs
  `user:impersonate` (`authz.impersonation.permission`) and must have signed in interactively. The target's combined `$global` permission set, from every model and ABAC
  policies included, must be a strict subset of the caller's. Equal is refused. Protected roles
  (`authz.impersonation.protectedRoles`) are refused. An instance admin has no implicit org rights
  (H26).
- **How (authn):** `AuthnImpersonationService` owns the session block. Without a registered
  `ImpersonationGuard` every start is refused (`no_guard`). A start needs an active session of the
  actor that is `aal2` (when `authn.impersonation.requireMfa`) and fresh, or re-authenticated inline
  with the password (when `authn.impersonation.requirePassword`). The actor and the target must be
  active. The target must be a `user` and not the actor, and nesting is refused. A start issues a new
  session and revokes the old one. The principal is the target, with `authn.impersonator` set.
- **Sessions of an impersonation:** such a session is never fresh, and `reauthenticate` refuses it, so the
  target's password cannot act as the impersonator's proof.
- **End:** an explicit stop, logout, `authn.impersonation.maxMinutes` (default 60),
  `authn.session.expiration.maxLifetime` counted from the actor's login, or any revocation of the
  impersonator (a ban, a deactivation, a password change on other sessions, a reset, or a lost
  `user:impersonate`) (A20, SR-06). The service asks the guard again on every request of the
  session, with the actor's role switch, and a refusal ends the impersonation. A stop issues a new
  session for the impersonator. An ended
  impersonation resolves to no principal, never to the impersonator, because a request cannot rotate
  the cookie.
- Every start, end and expiry is audited.

## Package set per app type

| App type | Packages |
|---|---|
| Session web app | `users`, `users-http`, `authn`, `authn-orm`, `authn-session`, `authn-local`, `authn-http`, one `session-provider-*`, plus the authz packages (`authz`, `authz-rbac`, `authz-orm`, `authz-http`). Add `authn-totp` for 2FA and `authn-token` for API tokens. |
| Machine-only service | `authn`, `authn-orm`, `authn-http`, `authn-keys` or `authn-token`, `authz`, `authz-rbac`, `authz-http`. No `users`, no session packages. |
| SSO app | The session web app set plus `authn-oidc`. |

`authn-http` registers a route group only when the matching service is registered. An app that
forgets a package has no login route for it. Machine-only apps still configure `authn.*`. That is why
authentication has its own config root (D21).

## Config `authn.*`

The block below is the design's sample (§22.5); the table says who reads each key group.

```ts
export default {
  authn: {
    strategies: [{ name: 'local', service: 'LocalPasswordStrategy' }],
    local: {
      hasher: { service: 'Argon2PasswordHasher', maxConcurrent: 8 },
      pepper: { secret: null, version: 1, previous: [] },
      policy: { minLength: 8, maxLength: 128, rule: null, blocklist: null },
      generator: { length: 16, characters: ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'] },
      reset: { ttlSeconds: 3600, url: '', revokeTokens: true },
      invite: { ttlSeconds: 900 },
      expiration: { enabled: false, maxAgeDays: 31 },
    },
    session: { service: 'MemorySessionStore', expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 },
               pendingTtlSeconds: 300, cookie: { name: 'ssid', hostPrefix: 'auto', secure: 'auto', sameSite: 'strict' }, hashIds: true },
    mfa: { policy: { service: 'DefaultMfaPolicy', force: false, forceForRoles: [] },
           steps: [{ name: 'totp', service: 'TotpMfaStep' }], encryptionKey: { secret: null },
           totp: { issuer: 'SpinaJS', algorithm: 'SHA1', digits: 6, period: 30, window: 1, recoveryCodes: 10 } },
    throttle: { /* see Throttling */ },
    freshAuth: { maxAgeSeconds: 300 },
    token: { prefix: 'spt_', length: 32, maxTtlDays: 90, defaultTtlDays: 30, agentMaxTtlMinutes: 1440, headerName: 'x-api-key', lastUsedUpdateInterval: 60 },
    jwt: { issuers: [] },
    keys: { algorithms: ['EdDSA', 'ES256'], challenge: { ttlSeconds: 120, audience: null },
            assertion: { typ: 'spinajs-client+jwt', audience: null, maxLifetimeSeconds: 300, skewSeconds: 30 },
            httpSignature: { maxAgeSeconds: 300, skewSeconds: 30, requiredComponents: ['@method', '@target-uri', 'content-digest'] } },
    linking: { jit: false, byVerifiedEmail: false },
    impersonation: { requirePassword: true, requireMfa: true, maxMinutes: 60 },
    audit: { sampleUse: 0.01, hashIdentifiers: true, sinkTimeoutMs: 2000 },
    http: { trustProxy: null, csrf: { enabled: true, allowedOrigins: [] } },
  },
};
```

| Key | Package that reads it | Notes |
|---|---|---|
| `authn.strategies` | `StrategyRegistry` (N1) | A list of `{ name, service }`. Packages ship no entry. See [How a login runs](#how-a-login-runs). |
| `authn.local.*` | `authn-local` | No code reads `hasher.service`: the registered `PasswordHasher` (`Argon2PasswordHasher`) runs. `expiration.enabled` defaults to `false`. |
| `authn.session.*` | `authn-session`, `session-provider-*` | `hashIds: false` fails boot (schema). |
| `authn.mfa.*` | `authn-orm` (storage), `authn-totp` (`totp.*`, `encryptionKey`) | The upgrade migration needs `encryptionKey` when a user has a 2FA secret. Boot needs it outside development and test when a listed step stores secrets. `authn-totp` ships `authn.mfa.totp` only: no step and no key ([MFA](#mfa)). |
| `authn.throttle.*` | N1, `authn-orm` (`DbAuthnThrottle`) | The schema holds the defaults. `service` names the throttle; unset, the only registered throttle runs, or the only one besides `MemoryAuthnThrottle` (see [Throttling](#throttling)). `maxRows` caps `MemoryAuthnThrottle` per flow (1,000,000 when unset). |
| `authn.token.*`, `authn.jwt.issuers` | `authn-token` | |
| `authn.keys.*` | `authn-keys` | |
| `authn.linking.*` | `DefaultAuthnService` (N1), `authn-token`, `authn-oidc` | The core reads the global switches; a login links only when the strategy's own switch is on too (an OIDC provider's `linking.*`, a JWT issuer's `linking.jit`; K6). |
| `authn.oidc.*` | `authn-oidc` | See [oidc.md](./oidc.md). |
| `authn.impersonation.*` | `AuthnImpersonationService` (N1) | All three keys are read by the core service; `authn-http` serves `/auth/impersonate`. |
| `authn.freshAuth.*` | `FreshAuthCheck` (N1), `authn-http` | `maxAgeSeconds`: how old a sign-in may be before a sensitive route asks for `reauthPassword`. |
| `authn.audit.*` | `AuthnAudit` (N1), `authn-orm` | `sinkTimeoutMs` (default 2000) bounds each sink. `hashKey.secret` (32+ characters) keys the hashes of `LogAuthnAuditSink`, and the throttle hashes of `authn-orm`. |
| `authn.http.*` | `authn-http`, `authn-oidc` | `trustProxy` (else `http.trustProxy`) for `ClientIp`, `CsrfOriginGuard` and the OIDC controller; `csrf.enabled` and `csrf.allowedOrigins` for `CsrfOriginGuard`; `publicOrigin` is the origin clients sign in `@target-uri` (unset: a signed request yields no principal). The schema takes `routes.prefix`, but nothing reads it: the routes are fixed. |

Secrets you set (`authn.mfa.encryptionKey`, `authn.local.pepper.secret`, `authn.audit.hashKey.secret`,
`http.cookie.secret`) are secret references (environment or a secret store), never inline values. The
boot refuses a public or missing value for the cookie secret outside development and test (A24), and
a deployment with no app env set counts as production here.

The schema fails boot on `token.length` below 32, an empty `token.prefix`, `totp.digits` below 6,
password bounds outside 8-128, `session.hashIds: false` and an `mfa.steps[].name` of `recovery`.

Keys the schema adds to the sample above: `authn.throttle.maxRows`, `authn.token.generation`,
`authn.audit.hashKey`, `authn.http.publicOrigin`, `authn.http.routes` (not read) and
`authn.jwt.issuers[].linking`.
`AuthnConfigBootstrapper` registers the schema.

**Old keys.** `authn` no longer detects 2.x keys; the `authz` detector fails boot on the `rbac.*` root and points at
`spinajs-authz-convert`, which maps each key (see [the migration guide](../authz/migration-guide.md)). No package
ships a `rbac.*` key.

## Testing

`@spinajs/authn-testing` holds what you need to test a strategy or a store.

- `runAuthnBehaviour(ids, harnessFactory, opts)`: the behaviour rules A01-A32, with facets and ports. A
  rule your harness cannot serve stays pending and names the missing ports.
- `runStrategyConformance` and `runIdentityStoreConformance`, plus wrappers for the session issuer, the
  secret store, the link store and the throttle.
- Fakes: `FakeClock`, `FakeIdentityStore`, `MemoryPasswordCredentialStore`, `MemorySecretStore`,
  `FakeMfaStep`, `FakeStrategy`, `MemorySessionIssuer`, `FakeAuthnService`, `FakeBackoffThrottle`.
- `loadC8Fixtures()`: the canvas golden tickets.

Read `packages/authn-testing/README.md` ("Running the behaviour rules in a lane" and "Known gaps for
lanes") before you write a harness. Timing cases (A02) can take minutes on a loaded machine.
