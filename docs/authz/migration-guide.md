# Migrating from SpinaJS 2.x to 3.0: authorization and authentication

This is the one guide for both families. 3.0 splits `@spinajs/rbac` into identity (`users`),
authentication (`authn`) and authorization (`authz`). There is no compatibility mode and no 2.x
maintenance branch (H6, H11). You change config, imports, decorators, runtime checks and clients in
one step, and the database in another.

Related documents:

- [Authorization in 3.0](./README.md)
- [Authentication in 3.0](../authn/README.md) and [OIDC](../authn/oidc.md)
- Design: `docs/plans/2026-10-01-authz-v3-design.md`. Rule numbers (H1, B24, A31, SR-01) point there.

This guide describes `3.0.0-rc.1`. What is still open is in [section 11](#11-open-items-in-300-rc1). The
release notes (`RELEASE_NOTES.md` at the repository root) list every breaking change in one place.

## Contents

1. [Who must read this, and what changes](#1-who-must-read-this-and-what-changes)
2. [Packages](#2-packages)
3. [Config](#3-config)
4. [Running `spinajs-authz-convert`](#4-running-spinajs-authz-convert)
5. [Code](#5-code)
6. [Worked examples (yourscreen-backend)](#6-worked-examples-yourscreen-backend)
7. [Data migration](#7-data-migration)
8. [Steps for an app](#8-steps-for-an-app)
9. [Behaviour changes, lane by lane](#9-behaviour-changes-lane-by-lane)
10. [Security fixes an app sees](#10-security-fixes-an-app-sees)
11. [Open items in 3.0.0-rc.1](#11-open-items-in-300-rc1)

## 1. Who must read this, and what changes

Read this if your app depends on any of `@spinajs/rbac`, `rbac-http`, `rbac-http-user`,
`rbac-http-admin` or `rbac-http-token`, or reads `rbac.*` config.

What bites, on one screen:

| Change | What you see | What you do |
|---|---|---|
| **Union of roles (H1)** | A user with several roles gets the grants of all of them. 2.x mixed the active role and all roles. A role switch now only narrows. | Before the data migration, list users with several roles (step 5). Decide that the union is meant. |
| **Unattended work is denied (H2)** | CLI commands, cron jobs, queue handlers, `@Task` bodies, sockets without a user and config polling have no principal. Every check denies them, and a query on a scoped ORM model throws. | Wrap the entry point in `authz().runAs(SYSTEM, 'reason', fn)`, or run the job as its initiator (step 4). |
| **`users.Role` is dropped (H13)** | The column is copied into `authz_assignment` and then removed. Raw SQL and `User.Role` stop working. Rolling back to 2.x needs the `down()` of the drop migration first. | Remove every read of the column. Back up first (step 7). |
| **Empty CORS list allows nothing (H33, A31)** | 2.x answered every origin, with credentials, when `http.cors.origins` was empty. 3.0 sends no CORS headers. | List every origin a browser client uses (step 8). |
| **Cookie writes need a same-origin request (A22)** | A cookie-authenticated request with an unsafe method from another origin gets 403 `E_CSRF_ORIGIN`. Behind a TLS proxy the app sees its own origin as `http://…`, so every cookie write gets 403 until you act. | Set `http.trustProxy`, or list the public origin in `authn.http.csrf.allowedOrigins` (step 8). |
| **No lockout (H31)** | Accounts are never locked. Failed logins back off per account and per IP, up to a cap. `lockoutTime` is gone. | Tune `authn.throttle.login` if the default is too weak. |
| **Session cookie `__Host-ssid`** | Outside development and test the cookie is named `__Host-ssid`, with `Secure`. An unset env counts as production (step 6). Every 2.x session is logged out at the upgrade. Clients that hard-code `ssid` break. | Change such clients. For local http, name the env (`APP_ENV=development`). `secure: false` alone no longer relaxes the cookie. |
| **Resets and invites carry over (H35)** | Pending password resets and invites become hashed `authn_secret` rows with their 2.x expiry. A link already mailed works once. `down()` cannot restore them. | Nothing, unless you roll back. |
| **No re-export shims (H25)** | The old npm names stop at 2.x. They get `npm deprecate` and nothing else. | Change dependencies and imports (step 1). |
| **`rbac.*` config fails boot** | No package reads or ships a `rbac.*` key. Boot fails on one and names the converter, because `authz.config.rejectLegacyKeys` and `authn.config.rejectLegacyKeys` default to `true`. `false` only warns. | Run the converter, then delete every `rbac.*` key (step 2). |
| **PostgreSQL needs `jit = off`** | authz-orm refuses a PostgreSQL connection that runs with `jit = on`, the server default, at domain boot or at the first scoped query. With JIT on, rule lists take seconds. | `ALTER ROLE <role> SET jit = off` (or per database, or `PGOPTIONS='-c jit=off'`). `authz.orm.allowJit: true` turns the check off. |
| **`@Access` on class and route combine** | 2.x let the route replace the class. 3.0 ANDs them. | Check controllers that relied on the replacement. |
| **Token expiry is mandatory** | Tokens without `ExpiresAt` get `CreatedAt + authn.token.maxTtlDays` at migration. | Tell the owners (the converter lists them with `--db`). |
| **A token's role never exceeds its owner's** | The 2.x grant-subset check is gone. A role the owner lacks grants nothing. | Port or drop a custom token role policy (example g). |

## 2. Packages

### 2.1 Where each 2.x package went

| 2.x package | 3.0 packages | What moved |
|---|---|---|
| `@spinajs/rbac` | `@spinajs/users`, `authn-local`, `authn-session`, `authz-rbac` | **users:** `User`, metadata, lifecycle actions, mails, profile, user CLI, cron, migrations. **authn-local:** login, password hashing and policy, reset, change, expiry. **authn-session:** sessions, cookie, expiration. **authz-rbac:** grants, roles, assignments. Deleted: `permission-service`, `orm-permission`, `middleware`, `ownership`, `impersonation.ts`, the `AccessControl` bootstrap, `User.can*`, `User.Role`. |
| `@spinajs/rbac-http` | `@spinajs/authn-http` (and `authz-http`) | Session middleware, session policies, route args. `RbacPolicy`, `@Permission`, `@Resource`, `GrantsController` are replaced by `authz-http`. |
| `@spinajs/rbac-http-user` | `authn-http`, `authn-totp`, `users-http` | Login, reset, sessions, impersonation and role-switch routes to `authn-http`. 2FA to `authn-totp`. Profile and metadata routes to `users-http`. |
| `@spinajs/rbac-http-admin` | `users-http`, `authn-http`, `authz-http-admin` | Record routes to `users-http`. Credential routes to `authn-http` under `/authn/admin/users/:uuid/*`. Role routes to `authz-http-admin`. |
| `@spinajs/rbac-http-token` | `authn-token`, `authn-http` | Token model, generator, validation, CLI and migrations to `authn-token`. `/user/tokens` to `authn-http`. |
| `@spinajs/session-provider-db`, `-redis`, `-dynamodb` | same names | Now implement the `authn-session` contract. |
| `@spinajs/orm-api` | none | Removed (H5). |

New packages: `authn` (core), `authn-orm`, `authn-keys`, `authn-oidc`, `authz`, `authz-abac`,
`authz-orm`, `authz-http`, `authz-queue`, `authz-fs`, the test kits `authz-testing` and
`authn-testing`, and the tool `authz-convert`.

Rules for the move (§4.1.1):

- Table names and migration class names do not change (`users`, `users_metadata`, `user_sessions`,
  `rbac_access_tokens`, `RBACInitial_2022_06_28_01_13_00`). The ORM keys migration history by class
  name, so a renamed class would run again.
- DI class names stay where the class keeps its job (`SessionProvider`, `MemorySessionStore`,
  `AbsoluteExpiration`). Classes that change their job get new names: `SimpleDbAuthProvider` is now
  `LocalPasswordStrategy`, `TwoFactorAuthProvider` is now `MfaStep`, `RbacMiddleware` is now
  `AuthnMiddleware`.
- The 2.x queue events `UserRoleGranted` and `UserRoleRevoked` become `RoleAssigned` and
  `RoleRevoked`. The other user events keep their names through `users`' `QueueAuthnEventSink`.
- Logger names (`rbac`, `rbac-http-token`, `rbac-http-user`) and the queue connection
  `rbac-user-empty-queue` stay as they were.

### 2.2 The package set of an app

| App type | Packages |
|---|---|
| **Session web app** (login page, cookies) | `users`, `users-http`, `authn`, `authn-orm`, `authn-session`, `authn-local`, `authn-http`, `authz`, `authz-rbac`, `authz-orm`, `authz-http`, and one `session-provider-*`. Add `authn-totp` for 2FA, `authn-token` for API tokens, `authz-abac` for policies, `authz-http-admin` for role routes. |
| **SSO app** | The session web app set plus `authn-oidc` ([OIDC](../authn/oidc.md)). |
| **Machine-only service** (runner gateway, telemetry) | `authn`, `authn-orm`, `authn-http`, `authn-keys` or `authn-token`, `authz`, `authz-rbac`, `authz-http`. No `users`, no session packages. |

An app that forgets a package has no login route for it: `authn-http` registers a route group only
when its service is registered (§22.11).

## 3. Config

Three roots replace `rbac.*` (H3, H24): `authz.*` for authorization, `authn.*` for authentication,
`users.*` for identity. `spinajs-authz-convert` writes all three ([section 4](#4-running-spinajs-authz-convert)).
The table shows the target and what the converter does.

### 3.1 Authorization keys

| 2.x | 3.0 | Converter |
|---|---|---|
| `rbac.grants.R.X['v:any'] = ['*']` | `authz.rbac.roles.R.grants: ['X:v']` | One grant for each of create, read, update, delete that the role has. Never `X:*`. |
| `rbac.grants.R.X['v:own'] = ['*']` | `{ permission: 'X:v', relation: 'owner' }` | Relation `owner`, except on the resource `user`: relation `self` (`--self-resources`). `users` stays `owner`. |
| `'v:own': ['scope:polsat']` | `{ permission: 'X:v', relation: 'polsat' }` | `scope:x` becomes relation `x`. `scope:` on an `:any` grant is refused. `scope:owner` and `scope:self` are refused. |
| Attribute lists `['*', '!Password']` | `fields: { read: [...] }` on read grants, `fields: { write: [...] }` on create and update grants | No `fields` for a list of `['*']`. None on delete. |
| `$extend: [...]` | `extends: [...]` | Only the app's part is written. The 3.0 packages define their own `system`, `admin` and `admin.users`. |
| Roles nobody is assigned | `assignable: false` | Only with `--db`. Without it every role stays assignable. |
| `rbac.roles: [{ Name }]` | A key in `authz.rbac.roles` | A role without grants is written with `grants: []`, so its assignments stay valid. A name that differs from a granted role only in case is not written. |
| `rbac.defaultRole` | `authz.rbac.defaultRoles` (new users) | Written when the app sets it. |
| `rbac.enableGuestAccount` | `authz.principals.anonymous.enabled` | When `true`, `authz.rbac.anonymousRoles: ['guest']` too. |
| `rbac.systemRole`, `rbac.requireKnownRole` | removed | Warned if non-default. `SYSTEM` is a principal. Unknown roles always fail. |
| `rbac.roleColumn` | `authz.rbac.migration.roleColumn` | Written. The `users.Role` copy migration reads it. |
| `rbac.roleSwitch.requirePassword` | `authz.principals.roleSwitch.requirePassword` | |
| `'user:impersonate': { 'create:any' }` and `rbac.impersonation.protectedRoles` | permission `user:impersonate` and `authz.impersonation.protectedRoles` | Adds the 2.x package part (`['system']`). |
| `rbac.admin.roleGuard.*` | `authz.admin.guard.*` | `DefaultRoleGuard` becomes `DefaultAdminGuard`. `privilegedPermission` defaults to `'users:update'` in 3.0. The converter writes `<privilegedResource>:<verb>` only when the app set `privilegedResource` or `privilegedAction`, and asks you to set it by hand when the action is an `:own` one. A custom guard is written as found; boot fails until you port it. |
| `rbac.token.rolePolicy`, `excludedRoles` | `authz.token.rolePolicy`, `authz.token.excludedRoles` | A custom policy is written as found; boot fails until you port it. |

The converter also writes `authz.permissions` for every permission it saw, with `fields: true` where a
grant carries a field list. A permission you do not register is an error at boot (B02).

### 3.2 Authentication keys

| 2.x | 3.0 | Converter |
|---|---|---|
| `rbac.auth.service` | `authn.strategies: [{ name: 'local', service: 'LocalPasswordStrategy' }]` | Written for `SimpleDbAuthProvider`, and when `rbac.auth` is unset. A custom provider is a manual item. |
| `rbac.password.service` | `authn.local.hasher.service` | `BasicPasswordProvider` becomes `Argon2PasswordHasher`. |
| `rbac.password.validation.rule`, `.description` | `authn.local.policy.rule`, `.description` | |
| `rbac.password.generator` | `authn.local.generator` | Adds the 2.x package character sets to `characters`. |
| `rbac.password.passwordResetWaitTime` | `authn.local.reset.ttlSeconds` | |
| `rbac.password.invite.waitTime` | `authn.local.invite.ttlSeconds` | |
| `rbac.password.resetUrl` | `authn.local.reset.url` | |
| `rbac.password.expiration` | `authn.local.expiration` | `passwordExpirationTime` seconds become `maxAgeDays`, only for whole days. |
| `rbac.password.blockAfterAttempts` | `authn.throttle.login.account` | `free` is the old value; the delays are the schema's defaults. A warning explains the new meaning. 0 turns nothing off. |
| `rbac.password.lockoutTime` | dropped | Warning. The nearest knob is `authn.throttle.login.account.maxDelayMs`. |
| `rbac.session.*` | `authn.session.*` | Same sub-paths. |
| `rbac.twoFactorAuth`, `rbac.otpauth.*` | `authn.mfa.steps`, `authn.mfa.policy.force`, `authn.mfa.totp.*` | `forceUser` becomes `policy.force`. The step it writes is `TotpMfaStep`, which `authn-totp` ships. Boot finds it when the app loads `@spinajs/authn-totp`. The step also needs `authn.mfa.encryptionKey.secret` and `import '@spinajs/authn-totp/db'` (a `MfaSecretStore`); see the [N5 section](#n5-authn-totp). Without the import it fails on first use, not at boot. |
| `rbac.token.{prefix,length,headerName,lastUsedUpdateInterval,generation}` | `authn.token.*` | A length below 32 is a manual item (boot fails). |
| `rbac.impersonation.requirePassword` | `authn.impersonation.requirePassword` | |
| `rbac.user`, `rbac.email`, `rbac.actions` | `users.user`, `users.email`, `users.actions` | Copied. Functions in `actions` cannot be written to a file: they are manual items. |

### 3.3 Where the 2.x package defaults went

The converter reads only your own config files. Where your app ran on a 2.x package default, it
writes the 3.0 key when 3.0 needs it, and lists the rest in `authz-warnings.md`:

| 2.x default | 3.0 | Converter |
|---|---|---|
| Local login (`SimpleDbAuthProvider`) when `rbac.auth` is unset | `authn.strategies` lists it | Written. |
| Lockout after 5 failed logins (3 with `rbac-http-user`) for 15 minutes | Backoff, never a lock | Listed. |
| Default role `guest` for new users | None unless `authz.rbac.defaultRoles` is set | Listed. |
| No guest account | `authz.principals.anonymous.enabled` is `true` by default | Listed. Set it to `false` to match 2.x. |
| Password expiry after 31 days | Off unless `authn.local.expiration.enabled` | Listed. Set it, and `maxAgeDays`, if you relied on it. |
| TOTP on by default | `authn.mfa.steps` | Listed (manual). |
| Public cookie secret `'1234adreewD'` | Boot refuses a public or missing secret outside development and test. With no env set, authn treats the deployment as production and refuses it too (step 6). | Listed. |
| Empty `http.cors.origins` reflects every origin | Allows none (H33, step 8). | Listed. |
| No `http.trustProxy` | Set the hop count or CIDRs behind a proxy | Listed. |

### 3.4 Keys that other config files own

- `http.cors.origins` and `http.trustProxy` stay under `http.*`. `http.trustProxy` names the proxies
  whose `X-Forwarded-For` counts: a hop count, or addresses, CIDRs and the names `loopback`,
  `linklocal` and `uniquelocal`. `null` or `0` means no proxy; `true` means one hop, never "trust
  all". `RealIp` (`@spinajs/http`) and authn-http's `ClientIp` read it (`authn.http.trustProxy`, when
  set, wins for authn). The client IP that throttling and audit use then comes from the proxy chain.
  A trusted proxy's first `X-Forwarded-Proto` and `-Host` count too, so the proxy must overwrite all
  three headers.
- `authn.http.csrf.allowedOrigins` lists origins that may send cookie-authenticated unsafe requests.
  The app's own origin is always allowed. Each entry must be an exact origin
  (`scheme://host[:port]`).

The AJV schema fails boot on `token.length` below 32, an empty `token.prefix`, `totp.digits` below 6,
password bounds outside 8-128, `session.hashIds: false` and an `mfa.steps[].name` of `recovery`.

**Core keys as built (N1).** `@spinajs/authn` ships defaults for `strategies`, `mfa.policy`,
`throttle`, `freshAuth`, `linking`, `impersonation`, `audit` and `config`. They equal the schema and
code defaults. The package lists **no strategy and no MFA step**, because config files concatenate
arrays: you list each strategy once, in one file. Every registered `AuthnEventSink` gets the audit
events; `authn.audit` has no sink list.
`authn.throttle.service` has no default. Left out, the only registered throttle runs, or the only one
besides `MemoryAuthnThrottle`. `@spinajs/authn` registers `MemoryAuthnThrottle`; importing
`@spinajs/authn-orm` adds `DbAuthnThrottle`, which then runs (K6) and needs `authn.audit.hashKey.secret`
outside development and test, or boot fails. Name the throttle when you register one of your own: with
two besides the memory one, an unset key fails boot ("several are registered; name one").

**Boot checks.** The first resolution of `AuthnService` runs them. Messages name keys and
services, never values.

| Check | Refused at boot | Only a warning |
|---|---|---|
| Strategies | An `authn.strategies` entry with no registered `AuthenticationStrategy` of that service name, a duplicate name, an entry name that differs from the strategy's own name, a strategy with a missing `interactive` flag or no credential kind | An empty list (reported by `authn:check-config` only) |
| Secrets (A24, SR-16) | `http.cookie.secret` missing, empty or the public `1234adreewD`; `authn.mfa.encryptionKey.secret` missing while a listed MFA step stores secrets; both **outside development and test**. A malformed pepper in every env fails boot as `InvalidConfiguration` with the full path of each bad value (`version` below 1, `secret` not a string or `null`, a `previous` entry without a non-empty `secret` and a version, a `previous` version that repeats or equals the current `version`) | The same secrets in development and test; an empty `authn.local.pepper.secret` there |
| Throttle | `authn.throttle.service` names a throttle that is not registered, or is unset while none or several are registered. Boot never falls back to memory, which would split the counts of a multi-instance app | |
| MFA policy | `force` or `forceForRoles` with no `authn.mfa.steps`; `forceForRoles` with no `RoleSource` or `PrincipalFactory` | |
| Audit | An unknown key in `authn.audit` (`sinks` included), a bad `sampleUse`, `sinkTimeoutMs` or `hashKey` (under 32 characters) | No sink registered at all |
| Neighbours | No `IdentityStore` or `PrincipalFactory`; with an interactive strategy, no `SessionIssuer` | |
| Env | | No env named by `--env`, `APP_ENV` or `NODE_ENV`: the configuration fell back to `development`, but authn treats the deployment as production, with the strict secret checks. The warning says so. |

**A missing env means production (SR-16).** When no env is named, the configuration still resolves to
`development`, but the authn core, the session cookie builders and `authn-oidc` treat the deployment as
production: strict secret checks, a `Secure` `__Host-` cookie and https-only provider URLs. Only an env
source that names development or test (`--env`, `APP_ENV` or `NODE_ENV`) relaxes them, never a config
file. The
core logs a warning that the env fell back, so name the env in every deployment anyway.

**Old-key detector.** Boot reads the `rbac` tree for the 2.x keys that moved into `authn.*` (the
table in section 3.2) and fails with one message that lists each key as `rbac.x -> authn.y` (or
`dropped`, with the reason), never a value. `authn.config.rejectLegacyKeys` defaults to `true`; set it
to `false` and the same message is only a warning, once per process. The authz host fails on every `rbac.*`
key, among them `rbac.user`, `rbac.email` and `rbac.actions`, which move to `users.*`
(`authz.config.rejectLegacyKeys`, also `true` by default). To only warn, set both switches to `false`. No 3.0 package ships a `rbac.*` key, so the
detectors name only keys of your own config.

**`authn:check-config`.** The command ships in `authn-http`; the check behind it is the function
`checkAuthnConfig(container)` of `@spinajs/authn`. It prints findings (`topic`, `level`, `message`)
and throws nothing. Of what boot refuses it covers the secret, throttle, strategy registration and
old-key checks, and it also warns about: an empty `authn.strategies`; neither `authn.http.trustProxy` nor `http.trustProxy` set; an `http.cors` whose
`origins` is not a list (`@spinajs/http` then refuses to start) or is empty or unset; the env fallback.
The topics are `strategies`, `secrets`, `proxy`, `cors`, `env`, `mfa`, `throttle`, `legacy` and
`schema` (a value the `authn.*` schema refuses, reported as its path and the rule, never the value).

## 4. Running `spinajs-authz-convert`

```sh
npm install --save-dev @spinajs/authz-convert
npx spinajs-authz-convert lib/mjs/config --out src/config --db rbac-facts.json --src src
```

- **Point it at the compiled config dir** (`lib/mjs/config` or `dist/config`). A dir that holds
  TypeScript sources is refused. Several dirs merge in order. It reads only the app's own files, not
  the 2.x package defaults.
- It runs the files the way the configuration loader does: the common files, then one layer for
  each env suffix (`rbac.local.js` is env `local`).
- It runs the config again in child processes, with `NODE_ENV` and `APP_ENV` set to each of
  `production`, `prod`, `development`, `dev` and `test`. It lists every value that changes. The
  converted files hold the values of one run. It also names files that read environment variables,
  themselves or through what they import.
- `--out <dir>`: where the files go (default `./authz-convert-output`). Existing files need `--force`.
- `--src <dir>`: scans app sources for `@OrmResource`, `@ResourceOwner` and `@OrmPermission`, to
  say which models need `@Owner` or an `@OrmScope` class.
- `--self-resources a,b`: resources whose `:own` means the caller's own account (default `user`).

### 4.1 Output

| File | Holds |
|---|---|
| `authz-generated.ts`, `authz-generated.<env>.ts` | `authz.rbac.roles`, `authz.permissions`, principals, admin guard, impersonation, token role policy |
| `users-generated.ts`, `users-generated.<env>.ts` | `users.user`, `users.email`, `users.actions` |
| `authn-generated.ts`, `authn-generated.<env>.ts` | strategies, local password, session, MFA, token, throttle |
| `authz-warnings.md` | what to convert by hand, behaviour changes, notes |

The base names have no dot: the 3.0 loader reads `name.js` as a common file and `name.<env>.js` as an
env file, so a name like `authz.generated.ts` would never load. Copy the files into the app's config
dir and compile them with the rest.

### 4.2 Export the database rows first (`--db`)

The converter does not connect to your database. It reads a JSON file you export **before** you run
the 3.0 migrations, because they drop `users.Role`. With it the converter marks package roles nobody
holds `assignable: false`, and it lists users with several roles, roles the config does not define,
and tokens without expiry.

```sql
SELECT Id, Login, Role FROM users;
SELECT Id, Roles, ExpiresAt FROM rbac_access_tokens;
```

Save the rows as one JSON file. Role lists may be arrays, JSON strings or comma lists:

```json
{
  "users":  [{ "Id": 1, "Login": "bob", "Role": "acme.salesman,partner.backoffice" }],
  "tokens": [{ "Id": 1, "Roles": "system", "ExpiresAt": null }]
}
```

The converter names a user by `Login`, else `Id`, else `Uuid`. On PostgreSQL you can build the file in one query
(adjust the quoting for your column names):

```sql
SELECT json_build_object(
  'users',  (SELECT coalesce(json_agg(json_build_object('Id', "Id", 'Login', "Login", 'Role', "Role")), '[]'::json) FROM users),
  'tokens', (SELECT coalesce(json_agg(json_build_object('Id', "Id", 'Roles', "Roles", 'ExpiresAt', "ExpiresAt")), '[]'::json) FROM rbac_access_tokens)
);
```

### 4.3 Read `authz-warnings.md`

The file has three parts:

- **Convert by hand:** the converter left these out, or wrote them as found. Boot may fail until you
  act. Examples: functions in config, unknown `rbac.*` keys, a custom role guard, a custom token
  role policy, a custom auth provider.
- **Behaviour changes and actions:** converted, but 3.0 behaves differently, or you must act. Examples:
  users who hold several roles, `:own` grants whose model has no `@Owner`, the cookie rename, the
  lockout change, the empty CORS list, a missing `http.trustProxy`, a cookie secret in a config
  file, tokens without expiry, the TOTP encryption key.
- **Notes:** converted as this guide describes. Examples: `$extend` joined with a package list, roles
  marked `assignable: false`, `scope:` tokens turned into relations.

Exit codes: `0` converted. `2` converted, with keys left to convert by hand. `1` refused or failed,
nothing written.

### 4.4 What it refuses

The converter never guesses. It refuses, and writes nothing, when the 2.x config holds:

- an action key `accesscontrol` rejects, or a resource name that is not a valid 3.0 permission
  resource (`[A-Za-z][A-Za-z0-9_.-]*`). **A logical resource such as `'ArrowClient:yourscreen'` is
  refused.** Rename it in 2.x first, in the config and in the controllers that name it;
- a `scope:` token on an `:any` grant (2.x ignored it), a token named `owner` or `self`, scope tokens
  next to negated attributes only, attributes with spaces around them, or an attribute that is not a
  3.0 field glob;
- an attribute list set in a common file and in an env file (2.x joined the lists before it read
  them), or a negation or `scope:` token on a key that a 2.x package also granted (`admin.users`,
  `user`, `guest`);
- a key that an env JS file and a common JSON file both set;
- a value of the wrong type.

It writes custom services as found (a role guard, a token role policy) and lists them, so boot
fails until you port them. It leaves out, and lists, values a file cannot hold (functions), unknown
`rbac.*` keys, custom auth, password and 2FA providers, and units that do not convert exactly.

### 4.5 Why four grants and never `X:*`

2.x lists one grant for each of create, read, update and delete. The converter does the same:

```ts
// 2.x: ArrowCampaign: { 'create:own': ['scope:polsat'], 'read:own': ['scope:polsat'], 'update:own': [...], 'delete:own': [...] }
{ permission: 'ArrowCampaign:create', relation: 'polsat' },
{ permission: 'ArrowCampaign:read',   relation: 'polsat' },
{ permission: 'ArrowCampaign:update', relation: 'polsat' },
{ permission: 'ArrowCampaign:delete', relation: 'polsat' },
```

It does not collapse them to `ArrowCampaign:*`. A glob would also grant any action registered later
on that resource, such as `user:impersonate`. You may collapse by hand when you want that.

## 5. Code

### 5.1 Decorators and APIs

| 2.x | 3.0 |
|---|---|
| `@Resource('X')` + `@Permission(['readAny','readOwn'])` | `@Access('X:read')` (`authz-http`) |
| `@Policy(TokenPolicy)` above `@Permission` | delete the line; `@Access` accepts token principals |
| `@Permission(['updateOwn'], TwoFactorAuthEnabled)` | `@Access('user:update', { also: [MfaSatisfied] })`; `TwoFactorAuthEnabled` is gone |
| `@SkipModelPermission()` | `@Unscoped('reason')` or `authz().runAs(SYSTEM, 'reason', fn)` |
| `user.canReadAny('X').granted`, `checkUserPermission`, `probeGrant`, `checkRbacPermission` | `await authz().can(authz().current(), 'X:read')` |
| `permission.filter(data)` | `filterFields(decision, data, 'read')` (`authz-orm`) |
| `PermissionService`, `ResourceRules<T>.owns()` | a `RelationResolver`, or `ownsBy(type, relation, fn)` (`authz-orm`), plus `authz().assert(...)` |
| `@OrmResource`, `@ResourceOwner` | `@AccessResource`, `@Owner` (`authz-orm`); the 2.x scoping is gone, so a model without `@AccessResource` is not scoped at all |
| `@OrmPermission(M, 'x') class P extends OrmPermissionPolicy` | `@OrmScope(M, 'x') class P extends OrmScopePolicy` with `scope(query, principal, op)` |
| `effectiveRoles(user, storage)`, `req.storage.ActiveRole` | `principal.ceiling?.roles`; `RbacService.rolesOf(principal, at)`. `req.storage.ActiveRole` and `req.storage.Session` are never set. |
| `grant(user, role)`, `revoke`, CLI `rbac:user-grant` | `AuthzAdmin.assign(actor, ...)`, `revoke`; CLI `authz:assign`, `authz:revoke` (`authz-rbac`) |
| `GET /grants`, `/user/grants`, `Grants` in login | `GET /user/access`, `POST /user/access/check`, and `Access` in the login, MFA, role switch, impersonation and whoami answers (users' `AccessResponseExtension`) |
| `DI.get('AccessControl')`, `import 'accesscontrol'` | removed; use `authz()` and `RbacService` |
| `user.Role`, raw SQL on `users.Role`, `withRole` | `RbacService.rolesOf(principal)`, `AssignmentStore.holders(role, scope)`, or a join on `authz_assignment` |
| `import { ... } from '@spinajs/rbac'` and the other `rbac*` packages | the new names of section 2 |
| `UserRoleGranted`, `UserRoleRevoked` subscribers | `RoleAssigned`, `RoleRevoked` (`subject`, `role`, `scope`, `actor`, `expiresAt`) through an `AuthzEventSink`; 3.0 ships no queue sink ([section 11](#11-open-items-in-300-rc1)) |
| `User2Fa*` queue events | gone; the audit events `mfa.enrol` and `mfa.disable` reach every `AuthnEventSink` |
| `login(email, password)`, `SimpleDbAuthProvider.authenticate` | `AuthnService.authenticate({ kind: 'password', login, password }, ctx)` (`DefaultAuthnService`) |
| `passwordChangeRequest`, `confirmPasswordReset`, `changeUserPassword` | `PasswordService.requestReset`, `.redeemReset`, `.change` (`LocalPasswordService` in `authn-local`) |
| `SessionProvider`, `UserSession`, `regenerateSession`, `revokeUserSessions` | `SessionProvider` from `@spinajs/authn-session`; `SessionIssuer.rotate`, `.revokeAll(subject)` |
| `TwoFactorAuthProvider`, `Default2FaToken`, `auth2Fa` | `MfaStep`, `TotpMfaStep`, `TotpService`, `AuthnService.completeMfa` (`authn-totp`) |
| CLI `rbac:user-enable-2fa` | `authn:mfa-reset <login>` (removes the enrolment, prints no secret); the owner enrols again through `/user/mfa` |
| `validateToken`, `createToken` | `TokenService.validate`, `.create` (`DbTokenService` in `authn-token`) |
| `@Policy(NoTokenAuthPolicy)` | `NoTokenAuthPolicy` from `authn-http` (a token or key caller gets 403 `session_required`) |
| `LoggedPolicy`, `AuthorizedPolicy` | `Authenticated` (a pending MFA session does not pass); `FreshAuth(seconds)` for fresh auth |
| `@User()` (users-http) | `@CurrentUser()` (users-http, the user record); `@CurrentPrincipal()` (authz-http); `@Identity()`, `@AuthnSession()` (authn-http) |
| metadata keys `2fa:*`, `user:pwd_reset:*`, `user:login:*` | gone from `users_metadata`; see [section 7](#7-data-migration) |

Removed with no replacement (§11.5): `@Resource`, `@Permission`, `RbacPolicy`,
`checkRbacPermission`, `checkUserPermission`, `checkRoutePermission`, `GrantsController`,
`IGrantsMap`, `FilterAttribute`, `@SkipModelPermission`, `ACL_CONTROLLER_DESCRIPTOR`, the swagger
`x-rbac-*` keys (use `x-authz-permission` and `x-authz-resource`), the `LogoutHandler` extension point
(listen for the `logout` event in an `AuthnEventSink`) and the `orm-api` package.

### 5.2 What the HTTP layer adds

- `@Access` on a class and on a route combine with AND. A `@Access` on a subclass replaces the one it
  inherits; a subclass route without its own `@Access` keeps the inherited one.
- `@Unscoped(reason)` keeps the principal. The ORM adapter skips the residual, and the call is
  audited once. It needs `@Access` on the same route.
- On a route with `@Access`, body fields outside `decision.fields.write` are stripped (or a 400 in
  `authz.fields.write.mode: 'reject'`), and `authz.fields.neverRead` is stripped from the input.
  **A route that must accept such a field** (an admin route that sets `Password`) needs
  `@UnfilteredInput(reason)`. This applies to `users-http` and `authn-http` routes too.
- `PrincipalMiddleware` must run after the session middleware (Order 5).
- New `authz.http.*` keys: `services` (header-token service principals), `links`, `explainRoute`,
  `access.domain`. See [the authz README](./README.md#adapters).
- Refusals have more than one body shape: `@Access` answers 403
  `{ error: 'forbidden', permission, resource, reason }`; authn-http policies answer
  `{ error: '<code>' }` (`unauthenticated`, `fresh_auth_required`, `session_required`, `impersonating`,
  ...); every authentication failure (login, MFA, re-auth, and OIDC for a client that is not a browser
  navigation) answers 401 `{ error: { code: 'E_AUTH_FAILED', ... } }`, while an OIDC browser navigation
  gets a 303 to the failure page; the CSRF guard answers 403
  `{ error: { code: 'E_CSRF_ORIGIN', ... } }`.
- Do not call `DI.clearCache()` in your tests. It wipes state that other packages keep in the cache
  (the HTTP error map, the file system provider map). Uncache the concrete types you created.

## 6. Worked examples (yourscreen-backend)

Paths are under `Screennetwork/agentic_development/agent-3/yourscreen-backend/packages`. The first
example is the converter's real output for an anonymised copy of that config
(`packages/authz-convert/test/fixtures/golden/acme-backend`; `acme` stands for the app's company,
`partner` for the back-office partner, `Campaign*` for the `Arrow*` models).

### 6.1 Before you convert yourscreen

The real yourscreen config needs three changes before the converter accepts it:

1. **Logical resources are refused.** Names such as `'ArrowClient:yourscreen'` are not valid 3.0
   resource names. Rename each one in 2.x, in the grants and in the decorators that use it. Rebuild,
   then convert the compiled config.
2. **`ScopedRoleGuard`** (`rbac.admin.roleGuard.service`) is written as found. Boot fails until you
   port it to an `AdminGuard`, or drop it for `DefaultAdminGuard`. A missing guard fails closed.
3. **`GrantSubsetTokenRolePolicy`** (`rbac.token.rolePolicy.service`) is written as found. 3.0 ports no
   grant-subset rule (B24, B07; see example g). Port a policy that narrows roles, or drop it for
   `OwnRolesTokenRolePolicy`.

### 6.2 Example (a): a role with `$extend` and `scope:partner`

```ts
// 2.x
'partner.backoffice': {
  $extend: ['user', 'route.home', 'route.salesman', 'route.campaigns', 'localisations.read', 'location.subscriptions'],
  CampaignView: { 'read:own': ['scope:partner'], 'create:own': ['scope:partner'], 'update:own': ['scope:partner'], 'delete:own': ['scope:partner'] },
  Campaign:     { 'create:own': ['scope:partner'], 'read:own': ['scope:partner'], 'update:own': ['scope:partner'], 'delete:own': ['scope:partner'] },
  Client:       { 'create:any': ['*'], 'read:own': ['*'] },
}
// 3.0, converter output (abridged)
'partner.backoffice': {
  extends: ['user', 'route.home', 'route.salesman', 'route.campaigns', 'localisations.read', 'location.subscriptions'],
  grants: [
    { permission: 'CampaignView:create', relation: 'partner' },
    { permission: 'CampaignView:read',   relation: 'partner' },
    { permission: 'CampaignView:update', relation: 'partner' },
    { permission: 'CampaignView:delete', relation: 'partner' },
    { permission: 'Campaign:create',     relation: 'partner' },
    // read, update, delete the same way
    'Client:create',
    { permission: 'Client:read', relation: 'owner' },
  ],
}
```

The 2.x comment "no `$extend` package may grant these resources `['*']`" is obsolete. An inherited
unconditional grant on `Campaign:read` would still widen the role, because roles are a union (H1).
Now the widening is visible in the config.

Roles that are only extended get `assignable: false` (with `--db`), such as `route.home` and
`users.self`. A role in `rbac.roles` without grants is written with `grants: []`.

### 6.3 Example (b): the scope policy

```ts
// 3.0 (@spinajs/authz-orm)
@OrmScope(Campaign, 'partner')
export class CampaignPartnerPolicy extends OrmScopePolicy<Campaign> {
  scope(q: IWhereBuilder<Campaign>, p: Principal) { partnerManagedWithinPool(q, p.attributes.pool as string | undefined); }
  authorizeCreate(q: InsertQueryBuilder, p: Principal) { q.forceColumn('campaign_management_company', 'partner'); }
  authorizeUpdate(q: UpdateQueryBuilder, values: Record<string, unknown>) { assertStaysInScope('campaign_management_company', [values.campaign_management_company], 'partner'); }
}
```

A separate `QueryMiddleware` that guarded updates (`PolsatCampaignUpdateGuard`) is deleted:
`authorizeUpdate` replaces it. It gets the update's values and, as its third argument, the principal.
A policy whose `scope` reads a column an update can write must implement it, because the update
check reads the relation from the stored row. `scope` runs as `SYSTEM` (for the check and for the
list), so read the principal from its argument, never from `authz().current()`. More rules:
`packages/authz-orm/README.md`.

### 6.4 Example (c): a controller

```ts
// 2.x
@Resource('ArrowCampaign') export class Campaigns extends BaseController {
  @Get('/') @Policy(TokenPolicy) @Permission(['readAny', 'readOwn']) getCampaigns(...) {}
  @Put(':campaign') @Policy(TokenPolicy) @Permission(['updateAny', 'updateOwn']) updateCampaign(@FromModel() campaign: ArrowCampaign, ...) {}
}
// 3.0
export class Campaigns extends BaseController {
  @Get('/') @Access('ArrowCampaign:read') getCampaigns(...) {}
  @Put(':campaign') @Access('ArrowCampaign:update', { resource: fromModel(ArrowCampaign, 'campaign') }) updateCampaign(...) {}
}
```

The long comment about decorator order and the OR trap goes away. `@Access` is one policy group.

### 6.5 Example (d): a rules class

`CampaignCommentPermission.owns()` becomes
`ownsBy('CampaignComments', 'author', (p, c) => c.addedBy === p.identity.Id)`. The service calls
`await authz().assert(authz().current(), 'CampaignComments:update', comment)` and maps
`decision.reason` to its own errors. `ownsBy` (from `@spinajs/authz-orm`) returns a `RelationResolver`
with no SQL form, for `@AccessResource` types only; register it in the domain's container before the
domain boots. A list cannot use such a relation in SQL, so give lists of that type an `@OrmScope`
policy when they need one.

### 6.6 Example (e): effective roles

The helper with three cases becomes principal fields. `ActiveRole` is `ceiling.roles`. A token
`Profile` is `principal.attributes.profile`, set when the token principal is built. Otherwise use the
RBAC roles. Its callers read `RbacService.rolesOf(authz().current(), at)` for decisions and
`principal.attributes.profile` for scoping. The invariant in the old comment holds: a profile never
widens a decision.

### 6.7 Example (f): header tokens that borrowed the system user

The legacy header policies become service principals. Use `authz.http.services` and give each its own
roles:

```ts
authz: {
  http: { services: [
    { name: 'legacy-v1', header: 'x-legacy-token', token: '<from your secret store>' },
    { name: 'api-v2',    header: 'x-api-token',    token: ['<current>', '<next>'] },   // a list allows rotation
  ] },
  rbac: { serviceRoles: { 'service:legacy-v1': ['legacy.v1'], 'service:api-v2': ['api.v2'] } },
}
```

The service source runs before every authn credential (order 40), and its principal is
`service:<name>`. A service role must be assignable at `$global`.

### 6.8 Example (g): the token role policy

The 2.x `GrantSubsetTokenRolePolicy` checked that a token's grants were a subset of the owner's
grants. 3.0 does not port that check. A token's roles are the token's roles, kept to those the owner
holds, and then to what `authz.token.rolePolicy` allows (B24). The token's roles reach the principal
as `ceiling.roles`, and `ceiling.roles` drops roles the owner lacks (B07). **A role the owner lacks
grants nothing, even when the owner's grants cover it.** The human decided this (D3). At creation,
`authn-token` refuses a role the owner lacks (`invalid_scope`) when a `RoleSource` is registered. That
check is defence in depth; the check at decision time is the authoritative one.

If your policy only narrowed the roles a token may carry, port it to a `TokenRolePolicy`
(`@spinajs/authz-rbac`) whose `allowedRoles(owner, roles, profile?)` returns fewer roles, and name it in
`authz.token.rolePolicy.service`. It must answer synchronously, from its arguments and config: RBAC
asks it on every check of a token principal. If your policy allowed more than the owner holds, remove
that part: it cannot work.

### 6.9 Example (h): the frontend

`new AccessControl({ _user: grants })` and `HasAccess(resource, action)` become a check on the access
summary from `GET /user/access`:

```ts
// AccessSummary.permissions: [{ name: 'PrimeSpot:read', conditional: true, fields?: { read, write } }, ...]
const can = (access, name) => access.permissions.some((p) => p.name === name);
```

`conditional: true` means "only rows in scope". Login, MFA, role-switch, impersonation and whoami
(`GET /auth`) answers carry the same `Access` object: users' `AccessResponseExtension` adds it.

### 6.10 Example (i): pools

Keep `User.Pool` and expose it as `principal.attributes.pool` through a `PrincipalAttributeProvider`.
Per-scope roles (a `salesman` role at `pool:primespot`) can later replace the 14 root roles, but that
is a follow-up, not part of the port.

## 7. Data migration

**Back up the database first.** The `users.Role` drop is the only 3.0 migration that deletes data
(§9.2), and a later `down()` cannot restore every row it touches.

| What | What happens | Needs |
|---|---|---|
| `users.Role` | Copied into `authz_assignment` as `$global` assignments of `user:<users.Uuid>`. A second migration drops the column, and refuses while the copy is incomplete. Its `down()` rebuilds the column from `$global` assignments. | `authz.rbac.migration.roleColumn` if your column is not `Role`; `authz.rbac.migration.idColumn` if your id column is not `Uuid` |
| TOTP secrets (`2fa:token`, ...) in `users_metadata` | Encrypted with AES-256-GCM into `authn_mfa`. `confirmed_at` is set when 2FA was enabled. `2fa:*`, `user:2fa:*` and `user:login:*` keys are deleted. | `authn.mfa.encryptionKey`. The upgrade refuses to run without it **when some user has a 2FA secret**. |
| Pending password resets and invites | Each unexpired token becomes one `authn_secret` row (SHA-256 of the token, purpose `reset` or `invite`, the 2.x expiry). Expired or malformed entries are dropped. `user:pwd_reset:*` keys are deleted. `user:invite:pending` stays. | |
| Throttle state (`user:login:*`) | Dropped. | |
| Session ids | `user_sessions.SessionId` is widened to 64 characters for hashed ids. 2.x sessions migrate lazily: the first request re-saves the session under the hash of its id. | |
| Tokens without `ExpiresAt` | Get `CreatedAt + authn.token.maxTtlDays` (default 90 days). | |
| Password hashes | Stay in `users.Password`. A login rehashes them when the pepper is set or changed. The argon2 cost stays at the library default, so 2.x hashes already match it. | |

Details you may need:

- **Carried-over secrets (H35, A32).** A link already mailed redeems once through
  `POST /auth/password/reset` until its old expiry, then fails like any expired secret. The migration
  counts live entries before and rows after, and fails on a mismatch. `down()` deletes the carried
  rows and names the affected users, who must ask for a new link. A mail still waiting in the queue
  keeps its clear link and it works, because its hash is now in `authn_secret`.
- **A 2.x start date without an offset** is read as UTC.
- **TOTP identity format.** The cipher binds a secret to `user:<Uuid>`. Do not rewrite user UUIDs
  between the migration and the first login.
- **Sessions after the upgrade.** A migrated session is `aal1` with `authenticatedAt` set to its
  creation time, so users with MFA step up or log in again. A migrated 2.x session that was not
  fully authorised comes back as a *pending* session. A 2.x session row that carries an `ActiveRole`
  is revoked on first use, and nearly every 2.x login wrote one, so expect users to log in again. The
  rename of the cookie to `__Host-ssid` outside development and test logs every 2.x session out anyway.
- **Rolling upgrade.** Stop every 2.x node before you start the first 3.0 node. A 2.x node does not
  know about hashed ids, so a ban or a revoke done by one version may miss a session of the other. If
  you ran mixed versions, re-run the redis sweep afterwards.
- **Store limits.** `session-provider-db` supports MySQL, PostgreSQL and SQLite. `session-provider-redis`
  assumes a single Redis, not Cluster. DynamoDB never expires items by its TTL (it reads seconds, the
  rows store milliseconds, as in 2.x).
- **Run the server with `TZ=UTC`** when you use `authn-keys` on a database whose driver reads date
  columns in the local zone (`authn_key`, `authn_nonce`). Elsewhere an expiry inside a spring-forward
  hour can read back an hour late.
- **PostgreSQL** (`node-postgres`) reads `timestamp` as local time, so a value inside a local
  spring-forward gap reads back an hour late. No `authn-orm` decision depends on such a read.
- **MySQL and MSSQL**: default collations ignore case. Give identity, subject and hash columns a binary
  collation. A sub-second `authn.throttle` delay is not supported there.

**The `users.Role` migrations (L2).** Three migrations in `@spinajs/authz-rbac`, on the `default`
connection, run in the order of their timestamps:

1. `AuthzRbac_2026_10_01_00_00_00` creates `authz_assignment`, `authz_rule`, `authz_rule_subject`,
   `authz_link` and `authz_version`.
2. `AuthzRbacUserRoles_2026_10_01_00_01_00` copies the column.
3. `AuthzRbacDropUserRole_2026_10_01_00_02_00` drops it.

*The copy.* It reads `users.<roleColumn>` (default `Role`) page by page, splits the comma set
(trimmed, empties and repeats dropped), and inserts one `$global` assignment per user and role
with `source = 'users.Role'`. The subject is `user:<idColumn>` with `idColumn` defaulting to
`Uuid`, not `Id`, because 3.0 user principals are `user:<Uuid>`. The design says `users.Id`; the code
differs. A rerun adds nothing, because the unique index `authz_assignment_uq` ignores a repeated row.
It runs in one transaction and bumps `authz_version` of the root domain when it inserted rows.

- A `users` row whose id column is null or empty is skipped and its roles are not copied. The
  migration logs a warning with the count.
- No `users` table: it logs and does nothing, so an app without the `users` package migrates.
- A `users` table without the id or role column: it does nothing, with a warning when the table
  holds rows and an info line when it is empty. Set the two keys above and migrate again.

*The drop.* It checks before it changes anything. If a `users` row holds a role that has no live
`$global` assignment of its user (a missing row, or an expired one), it throws and changes nothing.
The message names up to five missing pairs, and says how to fix it: grant the role through
`AuthzAdmin.assign` or `authz:assign` (this also renews an expired grant), or remove it from the
column when you revoked it on purpose. Then run
`orm.Migration.resolve('AuthzRbacDropUserRole_2026_10_01_00_02_00', 'rolled-back')` and migrate
again. It also refuses when the id column is not unique (it counts the rows its walk saw against the
table count), when the table has rows but no id column, and warns about rows with roles but a null id
(those roles are lost with the column). On PostgreSQL it takes a `SHARE` lock on `users` between the
check and the drop, which stops a 2.x node that still writes users. Then it runs
`ALTER TABLE users DROP COLUMN <roleColumn>`.

*Rollback.* The drop's `down()` re-adds `<roleColumn>` as `varchar(256) NOT NULL DEFAULT ''` (2.x
had no default) and fills it from each user's live `$global` roles, sorted and joined with `,`. The
copy's `down()` deletes the rows with `source = 'users.Role'`. **Roll back batch by batch, the drop
first**, or with `{ all: true }`: `Migration.down(name)` acts only on the last applied batch. The copy's
`down()` also deletes a copied row that someone granted again after the copy. Dates on SQLite are
stored as local wall time (a repo-wide ORM issue), so run the process with a fixed time zone. MySQL
and MSSQL are not tested.

*Before and after.* Compare `SELECT count(*)` of users with a role against the number of distinct
`subject_id` in `authz_assignment` where `source = 'users.Role'`. The migration prints no counts.

## 8. Steps for an app

### Step 1: dependencies and imports

Replace the packages by the table in section 2 and fix the imports. The old npm names get
`npm deprecate` pointers and no shims (H25). Build. Check: no `@spinajs/rbac*` import is left
(`grep -r "@spinajs/rbac" src`).

Some packages register their services when they are imported, and no other package imports them for
you any more. At the top of the app's entry, before `Controllers` or `HttpServer` resolve:

- `import '@spinajs/users'`: `IdentityStore`, `PasswordCredentialStore`, `PrincipalFactory`, the
  impersonation and credential admin guards, `RoleSource` and the `Access` extension. Without it
  `AuthnService` fails its boot check for the missing `IdentityStore`.
- `import '@spinajs/authn-http'`: the session middleware. When only the controller scan loads it, it
  comes too late and no request is authenticated (the package logs an error that names this fix).
- `import '@spinajs/authn-totp'` when you want TOTP and the `/user/mfa` routes: `authn-http` no
  longer loads it. Also `import '@spinajs/authn-totp/db'` for its store (section 9, N5).
- `import '@spinajs/authz-orm'`, `'@spinajs/authz-queue'`, `'@spinajs/authz-fs'` and
  `'@spinajs/authn-oidc'` when you use them. Installing alone adds nothing (authz-queue's `job:read`
  grant included), except that `authn-oidc`'s config adds its controllers to the scan, so an installed
  `authn-oidc` mounts `/auth/oidc/*`; its strategies still need the import.
- Wire the RBAC model (and ABAC, if you use it) as
  [the authz README](./README.md#wiring-the-models) shows. No package does it for you.

### Step 2: config

Compile the app, run the converter ([section 4](#4-running-spinajs-authz-convert)), and copy the
generated files into the config dir. Read `authz-warnings.md` and act on every "convert by hand" item.
Then delete every `rbac.*` key from your own config files. No 3.0 package reads or ships one, and
boot fails on any that is left, naming the key and the converter (`authz.config.rejectLegacyKeys` and
`authn.config.rejectLegacyKeys` default to `true`; set them to `false` only to boot once with a
warning while you clean up). Check: the app boots.

Keys whose 2.x meaning changed:

- `rbac.roleSwitch.requirePassword` is not read. Set `authz.principals.roleSwitch.requirePassword` to
  the roles a role switch asks the password for. Unset, every role asks for it.
- `rbac.impersonation.protectedRoles` is not read. `authz.impersonation.protectedRoles` defaults to
  `['admin']`. The converter adds the 2.x package value (`['system']`) only when your config set
  `rbac.impersonation.protectedRoles`. If you relied on the 2.x default, set
  `authz.impersonation.protectedRoles` yourself (for example `['admin', 'system']`), or `system` loses
  its protection.
- `rbac.admin.roleGuard.*` becomes `authz.admin.guard.*`, read by `DefaultAdminGuard` (role changes
  through `AuthzAdmin`) and by users-http's `AccountGuard` (deactivate, ban, delete).
- `rbac.twoFactorAuth.*` becomes `authn.mfa.*`: list the `totp` step and set the key (N5 in section 9).
- `rbac.password.blockAfterAttempts` and `lockoutTime`: 3.0 backs off and never locks
  (`authn.throttle`).
- `rbac.timeline.*` and the `rbac:unban-schedule` job are gone. A ban stops counting once its
  duration has passed (`User.IsBanned` reads it). No `UserUnbanned` event or mail goes out then; only
  an explicit unban sends them.

### Step 3: decorators

Apply the table in section 5. Most names change by search and replace. `@Permission` lists need the
table: `['readAny', 'readOwn']` becomes `@Access('X:read')`, and the own/any split moves into the
role grants (`relation: 'owner'`). Check: the compiler finds no `@Permission`, `@Resource` or
`@Policy(TokenPolicy)`.

### Step 4: runtime checks and unattended entry points

- Replace runtime checks (`user.can*`, `checkUserPermission`) with `authz().can(...)`.
- Port every `OrmPermissionPolicy` class to an `OrmScopePolicy`, and mark scoped models with
  `@AccessResource`. The 2.x `@OrmResource` scoping is gone: a model you do not mark is not scoped
  at all.
- Add `runAs` where your code runs with no principal and touches a scoped model: your own CLI
  commands, `@Task` bodies, migrations, and `configuration-db-source` polling when its model has
  `@AccessResource`. users runs its own identity lookups (session restore, login, password reset) as
  `SYSTEM`. A queue handler runs unattended unless its job says `@Job({ runAs: 'initiator' })` or
  `@Job({ runAs: 'system' })` (`authz-queue`).
- Remove every read of `users.Role` and `user.Role`.
- Put `@UnfilteredInput(reason)` on routes that must accept a `neverRead` field.

Check: run the app's tests. A missing `runAs` shows as `AccessDenied` with reason `unattended`,
naming the model.

To find the models you missed, run your tests with `DbDecisionAudit` on (it writes `authz_audit`),
then run `authz:check-config --unattended`. It prints the resource types that were queried without
a principal, with a count, the most frequent first:

```
resource types queried without a principal:
  Task  14
  user  3
```

With no such row it prints `no unattended queries in the audit log`. It fails when `authz_audit` does
not exist. It reads the table on `authz.rbac.connection` (else `default`), while `DbDecisionAudit`
writes on the connection named `authz-audit`: map that name to the same database
(`db.Aliases: { 'authz-audit': 'default' }`). Turning `DbDecisionAudit` on takes three steps
(`packages/authz-orm/README.md`, "Database audit"): import `@spinajs/authz-orm/audit` before the ORM
boots, map the connection, and register and select it:
`DI.register(DbDecisionAudit).as(DecisionAudit)` with `authz.audit.service: 'DbDecisionAudit'`. The
key alone fails boot.

### Step 5: list the users who gain access

While the `Role` column still exists, find users whose roles will be unioned (H1):

```sql
SELECT Id, Login, Role FROM users WHERE Role LIKE '%,%';
```

The converter lists them too, from the `--db` file. For each, decide that the union is meant. Also
check roles that the config does not define: in 2.x a user holding one got no permission at all
(`accesscontrol` refused the whole list). In 3.0 that role is ignored, with a warning, and the others
apply. Export the `--db` rows now if you did not (section 4.2).

### Step 6: secrets, proxy and env settings

Set these before you run the migrations and before the first 3.0 start:

- `authn.mfa.encryptionKey` (a secret reference, never an inline value). The step 7 migration needs it
  when any user has a 2FA secret. Boot also refuses a missing key outside development and test when a
  listed MFA step stores secrets, and only warns in development and test;
- `authn.local.pepper.secret` (optional; see the authn README);
- a real `http.cookie.secret`, loaded from a secret reference. The boot refuses the public default
  outside development and test;
- `authn.audit.hashKey.secret` (32 characters or more), so throttle keys in `authn_throttle` are keyed
  hashes. Outside development and test, `DbAuthnThrottle` fails boot without it; in development and
  test it uses a random key per process and warns once. `LogAuthnAuditSink` without it also uses a
  random key per process, so the hashes in your logs change on each restart and differ between nodes;
- `authn.throttle.service` only when you register a throttle of your own (section 3.4);
- `http.trustProxy`: the proxy hops, or their addresses and CIDRs (section 3.4). Without it, every
  client behind the proxy shares one address for throttling and audit, and the CSRF guard sees the
  app's own origin as plain `http`;
- the app env (`APP_ENV` or `NODE_ENV`, or `--env`) explicitly, in every deployment. Outside
  development and test the session cookie is `Secure` and `__Host-` prefixed.

What happens when no env is named: the configuration resolves it to `development`, but authn treats
the deployment as production (SR-16). The secret checks are strict, the session cookie is `Secure`
and `__Host-` prefixed, and `authn-oidc` refuses plain-http provider URLs. The core logs a warning that
the env fell back (`authn:check-config` reports it under `env`). A local run over plain http
therefore needs `APP_ENV=development` (or `test`).

### Step 7: back up, then migrate

Back up the database. Run the migrations. They copy `users.Role` into `authz_assignment` and drop the
column (H13; `AuthzRbacUserRoles_…` then `AuthzRbacDropUserRole_…`, [section 7](#7-data-migration)),
move TOTP secrets into `authn_mfa` (needs `authn.mfa.encryptionKey`, step 6), carry resets
and invites into `authn_secret`, drop throttle state from `users_metadata` and widen
`user_sessions.SessionId`. Check: the migration's own counts match (enrolled users, live resets and
invites). Compare the number of users with a role before and after. If the drop migration refuses,
nothing changed: read its message, fix the missing grants, resolve it, and migrate again.

### Step 8: CORS

2.x answers every origin, with credentials, when `http.cors.origins` is empty. 3.0 then allows no
cross-origin request (H33, A31). List every origin your browser clients use in `http.cors.origins`.
For cookie sessions also list them in `authn.http.csrf.allowedOrigins`. A same-origin app needs
nothing. A listed origin matches exactly (scheme, host and port, with no prefix match) and is echoed
with credentials and `Vary: Origin`. An entry with a path, query, user info or wildcard host fails
boot. `*` answers other origins without credentials. `Forwarded` and `X-Forwarded-*` are never
allowed request headers.

**The CSRF origin guard (A22)** is on by default (`authn.http.csrf.enabled`). A request with an unsafe
method that carries the session cookie must send the app's own `Origin` or a listed one, or, with no
`Origin` header, `Sec-Fetch-Site: same-origin`. Otherwise it gets 403 `E_CSRF_ORIGIN` before any
controller runs, and the guard logs why. `Origin: null` is refused. Requests without the session
cookie (the login itself, key login, password reset) are not checked. Behind a TLS proxy, set `http.trustProxy` or list the public origin in
`authn.http.csrf.allowedOrigins`, or every cookie write gets 403. `@spinajs/http` now sends
`Referrer-Policy: strict-origin-when-cross-origin`; an app with its own helmet must not use
`no-referrer`, because browsers then send `Origin: null` on same-origin form posts.

Check: a browser client on a listed origin works, one on another origin gets no CORS headers, and a
cookie write from the app's own pages passes. `authn:check-config` warns when `http.cors.origins` is
empty or not a list ([section 3.4](#34-keys-that-other-config-files-own)).

### Step 9: clients

- Use `Access` (from `GET /user/access`) instead of `Grants`. The `/grants` routes are gone (H7).
- A client that sent the `ssid` cookie by name must send `__Host-ssid`, or it must be moved to a
  login that sets the cookie for it.
- A client that relied on a pending 2FA session to read `GET /auth` or to start impersonation must
  finish the MFA step first (D25). A pending session yields no principal.
- Check password limits in clients: 3.0 accepts 8-128 characters at login and never trims.
- An API client must send the token before it expires. Tokens need an expiry. A bearer or `x-api-key`
  value without the token prefix (`authn.token.prefix`, default `spt_`) is ignored, except a JWT in
  `Authorization`, so tokens issued under another prefix stop working.
- Routes moved: `GET /auth/whoami` is `GET /auth`; `/auth/2fa/verify` is `/auth/mfa/verify` (and
  `/auth/mfa/recovery`); `/user/2fa*` is `/user/mfa*`; `GET /user/refresh` is `GET /user`;
  `/user/grants` and the admin credential routes under `/users/security` are gone (the credential
  routes are under `/authn/admin/users/:uuid/*`). A login that needs a second factor answers
  `{ MfaRequired: [...] }`.
- Every authentication failure is the same 401 body `{ error: { code: 'E_AUTH_FAILED', ... } }`; a
  throttled login or MFA step adds `Retry-After`. The release notes list the new body fields and error codes per
  route group.

### Step 10: run the suite and the config checks

Run the app's tests. Then run the config checks:

- `authz:check-config` boots the authz service and loads the role stores. A bad role or ladder fails
  with a message that names the key. On success it prints `OK: <n> role(s), <m> ladder(s)`.
  `authz:check-config --explain-role <role>` lists the effective grants of a role, inherited ones
  included, one line each: the permission, then `relation=`, `on=`, `fields=`, `requiresTag=` and
  `grantedAt=` when set. `--unattended` is described in step 4. These commands ship in
  `@spinajs/authz-rbac`.
- `authn:check-config` (in `authn-http`) reports strategies, secrets, proxy, CORS, env, MFA, the
  throttle and old keys as findings ([section 3.4](#34-keys-that-other-config-files-own)). It prints key
  names, never secret values.

## 9. Behaviour changes, lane by lane

One subsection for each lane, from its report. A line "no app change" means
the lane adds contracts, tests or tools only. Where a later lane changed what an earlier one built,
the later subsection says so; the steps of section 8 and the release notes describe the end state.

### F0a: package skeletons

No app change. Twenty new packages at `3.0.0-alpha.0`. The 2.x packages stay at their 2.x version.

### F0b: package moves

The moves of section 2. Config files stay in `<pkg>/src/config/`, split by the reader. Identity keys
moved with the same sub-path (`rbac.user.profile` is now `users.user.profile`). Some authentication
keys moved only where the target keeps the shape and meaning of the 2.x value. The 2.x defaults and
classes that the moved packages kept for a while (`rbac.*` defaults, `TwoFactorAuthProvider`, the
abstract `RoleGuard`) are gone since R1; the converter writes the 3.0 shapes.

### F1 and F1a: contracts and principal types

- Permission names and globs are strict (`**` is invalid). An invalid name or glob throws
  `AuthzConfigError`.
- `Unauthenticated` extends `AuthenticationFailed`, so HTTP answers 401. `AccessDenied.decision` is
  not enumerable, so it never reaches a 403 body.
- Field globs have a work budget (1.5M steps, 1000 globs, 32 segments). A glob set over the budget
  throws, and the engine treats that as a deny.
- `SYSTEM` and `UNATTENDED` are frozen singletons. `principalKey` and `resourceKey` escape `%` and
  `:` (and `/` for resource types), so keys are unambiguous.
- Contract files are frozen after gate G1 by an API snapshot. A change, a doc comment included,
  needs an RFC.

### F2: DI changes

These change how containers behave. They matter if your app uses child containers.

- A singleton registered in the root container and first resolved through a child now lives in the
  **root**, with the root's dependencies, and survives `child.dispose()`. Tests must not use
  `DI.child()` to get fresh singletons.
- A child cannot change the dependencies of a root-owned singleton. To get a domain-specific
  instance, register the class in the child.
- `get(Array.ofType(X))` now honours `parent` and walks parents by default (a public API change).
- `di.resolved.*` events for such singletons fire on the root container.
- `child.uncache(Svc)` does nothing for such a singleton.
- `Array.chainOf(X)` is new. `resolve(Array.chainOf(X))` merges registrations across parent and child
  containers, and `getRegisteredTypes(Array.chainOf(X))` lists them in the same order. Unlike
  `Array.ofType` it returns factory and `NewInstance` results, and it may return a promise.
- A model registered only in a child domain must not use `@Injectable(AuthorizationModel)`. Register
  it on the child container. A root model may use the decorator.

### F3: engine

- A ceiling deny or a delegate deny does not stop the models. The reported reason is the one with the
  lowest `(priority, sortKey)` among all deny sources, so `agents_disabled` (100) beats `ceiling`
  (200). Only the principal gate, `unknown_resource` and a forbidden delegate end the check early.
- A principal of type `system` or `unattended` that is not the singleton is denied (a forged
  principal). A `SYSTEM` or `UNATTENDED` delegate is denied with `delegate`.
- `neverRead` limits writes too, `SYSTEM` included. A vote without `fields` contributes every field.
- The engine bounds its work: vote size, residual evaluation, and timeouts on `evaluate`, `preload`,
  `summary` and attribute loads (`authz.engine.modelTimeoutMs`). A timeout is a deny with
  `model_error`, and it is never cached.
- The decision cache (L2) key holds the full principal state. A decision that reads `identity`,
  `env`, `onBehalfOf.*` or `companions.*` is not cached. A faulted decision is never cached.
- `covers` fails closed. It is false for a refused or faulted target or holder.
- `filterNow` returns `undefined`, never a guess, when a model needs IO or was not preloaded for the
  principal the models run with.

### F4: host

- `AuthzDomains.service(name)` returns a promise. `authz()` is synchronous and throws until the
  domain's service booted. Resolve the service at boot. Register a child domain's models before its
  first `service()` call, and resolve `Configuration` before `AuthzDomains.create`.
- Only the root container and containers made by `AuthzDomains.create` are domains.
- The `rbac.*` detector fails boot and names the converter (`authz.config.rejectLegacyKeys`, default
  `true` since R1; `false` only warns).
- Per-domain keys: `authz.domains.<name>.{combine, engine, fields, cache, audit, permissions,
  disable}`. `bus` and `principals` come from the root only.
- A model's `init` runs once per instance. Its registrations are replayed in each domain that lists
  it. A model is disposed when the last domain that lists it is disposed.
- Every domain has its own `Authorizer` and `DecisionCache`.
- `runAs` audits (`authz.audit.runAs`) and preloads the principal, unless it is `SYSTEM` or
  `UNATTENDED`.
- A package feeds the boot checks with an `AuthzContributor`.

### F5: authz test kit and ledgers

No app change. The test-port ledgers (`packages/*/test/LEDGER.md`) say which 2.x tests move, adapt,
are rewritten or dropped. If you keep your own copy of those tests, use them as a guide.

### F6: authn contracts

- The session store contract is reshaped: `ISession` drops `UserId` and gains typed `Subject`,
  `Impersonator` and `State`. `deleteByUser` and `listByUser` become `deleteBySubject` and
  `listBySubject`. **A custom `SessionProvider` must be ported.**
- `reauthenticate` is a boolean. A throttled re-authentication sends no `Retry-After`, and a
  successful one counts for its own request only.
- The 2.x token `Profile` travels as `attributes.profile`. Keys that `PrincipalFactory` or a
  `PrincipalAttributeProvider` derives win over keys a strategy sets.
- A request without a session cookie is exempt from the CSRF origin check (step 8). This includes
  `POST /auth/login`, `POST /auth/keys/login` and `POST /auth/password/reset`.
- Per-request credentials (tokens, keys) use the `login` throttle flow, keyed by a stable credential id
  (token id, key id). Since K5 they count failures only: the service reads the throttle (`peek`) before
  it verifies and counts only a failure, so a valid API call adds nothing to the count.
- Boot fails on `token.length` below 32, an empty `token.prefix`, `totp.digits` below 6, password
  bounds outside 8-128, `session.hashIds: false`, and a step named `recovery`.
- OIDC limits: see [OIDC](../authn/oidc.md).

### F7 and F7b: authn test kit

No app change. `@spinajs/authn-testing` holds the behaviour rules A01-A32 and the canvas C8 golden
tickets. Use it to test an `AuthenticationStrategy` or a store of your own.

### G1prep and G1b: gate preparation

- The authz host config modules live in `src/host/config`, not `src/config`. The configuration
  loader loads every file in `lib/*/config` as config, which gave "object is not extensible" at boot.
  When you build from source, clean old `packages/authz/lib/*/config` output.
- `AuthzAdmin` fails closed when no guard is registered. `AssignmentStore.byId` exists for id-only
  commands.
- The 2.x packages moved to version 2.0.549 with the master merge. `RbacCliCommand` lives in `users`.

### D3: token roles

A token's role is never above its owner's role (B24, B07). See example g.

### K2, K3 and K3b: RFCs L3-1, L9-1 and N3-1

- `PasswordCredentialStore.set(id, hash, expected?)` is a compare-and-set. **A custom password store
  must implement it:** with `expected`, write only when the stored hash equals it (`null` means "no
  password") and answer whether it wrote; without `expected`, write unconditionally and answer
  `true`.
- A login that rehashes a password, and a voluntary password change, now write by compare-and-set,
  so a concurrent reset or expiry is not overwritten. A lost change answers `invalid` and revokes
  nothing.
- K3b, as built: `LocalPasswordService.change` writes the new hash with the stored hash that the old
  password matched as `expected`. A lost write audits `password.change` as a failure with the reason
  `stale`, answers `{ status: 'invalid' }`, and neither revokes nor rotates any session. It does not
  retry; the user submits again. The throttle counts the attempt as a success, because the old
  password did verify. Two changes over one old password: one lands, the other answers `invalid`. A
  login rehash that lands first makes the change answer `invalid` too.
- The other writes stay unconditional, on purpose: an admin `set` (and the CLI), an admin expiry, and
  a reset redeem read no password before they write, and act on fresh authority. An aged-password
  expiry that races a change writes its marker over the new hash, which fails closed: the password
  then reads as expired.
- No contract changed. If your app has its own change-password route that calls `verifyPassword` and
  then writes the hash, it still has the same race and bypasses `authn-local`: move it onto
  `PasswordService.change`. The 2.x route of `users-http` is gone (C2b); `authn-http`'s
  `PATCH /user/password` calls `PasswordService.change`.

### L1: RBAC model

- At `$global`, only `$global` assignments count. A scoped assignment, or a grant limited by a
  pattern, gives nothing there.
- Field sets: the union of the unconditional grants' fields. When no grant is unconditional for the
  request, the intersection over the conditional ones. A conditional grant's fields never reach
  every row.
- `ceiling.roles` filters by assigned role name (`[]` means none, absent means no filter).
- Bad data fails closed. An unreadable `expiresAt` is a `model_error`. A stored assignment whose role is
  unknown, not assignable or at a wrong scope type is skipped, with a warning.
- `authz.rbac.anonymousRoles` and `serviceRoles` must name roles that exist and are assignable at
  `$global`. A role with `scopeTypes` sits at `$global` only when it lists `'$global'`.
- Resource patterns: an exact id means that node and its descendants. A glob matches ids of its own
  type. A template value with `/`, `.` or `..` segments, or with glob characters, matches nothing.
- Role definitions reload when their version changes, and every `authz.rbac.cache.rolesCheckSeconds`
  (default 60).
- A share link's companion keeps no ceiling of its own inside the link scope. Intersect it into the
  link ceiling yourself (L1 security note).
- `covers` and `summary` now read model summaries, which closes the RFC L1-3 gap: a target whose
  permissions came only from scoped, bare-type or pattern-limited grants looked weaker than it was,
  and a caller without those permissions could impersonate it. See the E1 subsection below.

### L3: ABAC model and conditions

- `eq: null` and `ne: null` are refused at load. Use `{ null: true }` or `{ null: false }`.
- A missing attribute is UNKNOWN and fails closed. A deny on `dept eq 'ops'` also denies principals
  with no `dept`.
- A deny policy with `fields` also denies; it does not only hide the fields. The `hide-salary` example
  in the design would block services from `users:read`.
- `actorTypes` matches `req.actor`, else the principal.
- Capabilities `sync` is `'never'` unless every store is a `ConfigPolicyStore` and no policy has a
  condition or a scope, so `filterNow` returns `undefined` for most ABAC pairs.
- A permit policy that reads `scope.*` on a type-level request makes the ABAC vote indeterminate
  (B39). One such permit empties lists of that permission under `deny-overrides`.
- A failed policy reload keeps routing to the last good index and retries with backoff (1 s, doubling
  to 60 s). Only ABAC's own pairs are `model_error`.
- `authz_policy` has `actor_types` and `priority` columns, and no domain column. The migration runs on
  the `default` connection, so an app on another connection must create the table there.
- Register condition functions in the root container, or pass them to the model.

### L2: RBAC stores, migrations and CLI

The config, tables, migrations and commands are in the [authz README](./README.md#the-rbac-model)
and in [section 7](#7-data-migration). What changes for an app:

- `users.Role` becomes `$global` assignments of `user:<Uuid>` (the design says `users.Id`; the code
  reads `authz.rbac.migration.idColumn`, default `Uuid`). The drop migration refuses an incomplete
  copy.
- Rules in the database are narrower than rules in config: the SQL form must never be wider than
  the evaluator, so `authz_rule` refuses permission globs other than `*`, the ops `in`, `nin` and
  `pattern` in `when`, numeric strings, and order ops on values that are not numbers
  (`rule_not_compilable`).
- Forgetting a scope also deletes the assignments whose subject is a set at that scope. Otherwise a
  grant would come back when an id is reused.
- Several grants of the same subject, role and scope make one row; the later grant updates it and
  keeps its id, `created_at` and `source`.
- The stores do not check lengths on writes. A role over 128 characters, a subject id over 64 or tags
  over 512 give a raw database error on PostgreSQL, while SQLite stores them.
- `ConfigRoleStore` reads `authz.rbac` only. MySQL and MSSQL are untested for the authz tables, and
  their default collations ignore case, so give the role and subject columns a binary collation.
- Dates on SQLite are stored as local wall time. Run the process with a fixed time zone.
- The share link secret (`authz.rbac.links.secret`) has no default and is checked at first use.
- The default `rules` store is `ConfigRuleStore` (L1b).

### E1: `covers` and `summary` read model summaries

The rules are in the [authz README](./README.md#using-the-service) (RFC L1-3). What an app sees:

- **A model you wrote must implement `summarize`.** Without it, `covers` is false in every domain that
  routes the model, and no one can impersonate through it.
- `covers` is false when any compared plan uses a custom combinator, so an app with one gets no
  impersonation through `covers`.
- A target's deny never removes its summary entries from the comparison. It may rest on session facts
  that change under impersonation.
- A holder's permit can be time-bound or depend on data, and `covers` still counts it at that
  instant. The impersonation session may outlive it, so `AuthnImpersonationService` asks the guard
  (users' `AuthzImpersonationGuard`) again on every request of the session, with the actor's role
  switch; a refusal ends the impersonation. A permit that only a future companion would bring is not
  seen.
- `covers` judges one instant. `actor.*` is judged with the target as the actor.
- `summary` marks a permission that a summary lists but the check denies as `conditional: true`. A
  conditional permit no longer widens the holder's fields.
- Cost: at `$global`, up to 2 × (1 + number of types) checks per permission.

### L5: HTTP adapter

See section 5.2. In short: class and route `@Access` are ANDed (2.x let the route replace the class),
`@Unscoped` keeps the principal and is audited once, `@UnfilteredInput(reason)` opts a route out of
the field filter, and the `authz.http.*` keys are `services`, `links`, `explainRoute` and
`access.domain`. The explain route exists only when enabled and never in production. A share link
token opens a dead link (`link_invalid`) until the app registers a `LinkResolver`.

### L8: orm-api removed

The `@spinajs/orm-api` package is gone (H5). It had no consumers in the repository. If your app used
it, write the routes you need on `@Access`.

### L9: AuthzAdmin

- Authz data is written only through `AuthzAdmin`. Stores keep no public write methods.
- The default backend is `MemoryAuthzAdminBackend`. Set `authz.admin.backend: 'DbAuthzAdminBackend'`
  for a database.
- Idempotency keys are scoped to domain, actor and key, and kept for 24 hours. A replayed
  `createLink` is a `conflict`, because the token is shown once.
- New error codes beyond the design's list: `invalid_batch`, `invalid_query`, `invalid_command`.
- Declare the `authz:*.manage` permissions, or map commands to your own with `authz.admin.permissions`.
- `protectSystemRole`: a role with `assignable: false` is a system role. Only `SYSTEM` changes its rows.
- The tables `authz_scope_attribute` and `authz_admin_idempotency` use composite keys, which the MSSQL
  table compiler cannot create yet.

### N1: authn core

Config, boot checks and the old-key detector are in [section 3.4](#34-keys-that-other-config-files-own).
The flow is in the [authn README](../authn/README.md#how-a-login-runs). What an app sees:

- **Class names.** `DefaultAuthnService`, `StrategyRegistry`, `DefaultMfaPolicy`,
  `MemoryAuthnThrottle`, `AuthnAudit`, `LogAuthnAuditSink`, `AccountLinkService`, `FreshAuthCheck` and
  `AuthnImpersonationService`. DI keys classes by name, so the last two avoid the plain names: the
  `FreshAuth` policy and the 2.x `ImpersonationService` of `authn-http` would clash with them.
- **Service names are class names.** `authn.strategies` entries and `authn.throttle.service`,
  `authn.mfa.policy.service` name registered classes. The core registers
  no strategy and no throttle other than the memory one.
- **Dispatch (D1).** The core picks the listed strategies that accept the credential kind and,
  when the strategy has `accepts`, the credential itself. It counts the union of their throttle keys
  once, before it verifies an interactive strategy (password, MFA). A per-request strategy is peeked
  first and counted only on failure (K5). Only an `unsupported_credentials` answer passes the credential to the next
  strategy. Nothing checks at boot that one strategy shadows another.
- **Status.** `IdentityStore.status` is asked for every subject except `service` and `agent`; their
  strategies vouch for them. Only `user` identities get sessions. A key challenge gets no core MFA step
  (an IdP does its own, and a key proves possession): the core step applies to password logins only.
- **Throttle.** A success removes only that account's attempts from the IP key. The service builds the
  `account-ip` key itself and drops the one a strategy sends. The memory throttle keeps one table per
  flow, capped by `authn.throttle.maxRows` (1,000,000 when unset), and never evicts a row that still
  delays someone. It is one process; a multi-instance app names `DbAuthnThrottle` in
  `authn.throttle.service`.
- **Linking.** A verified email links to an identity only when the identity's own stored email
  matches. `findByLogin` also matches login names, so the core does not trust it alone.
- **Impersonation.** `authn.impersonation.requireMfa` means the actor's session is `aal2`;
  `requirePassword` means fresh auth or an inline re-authentication. An impersonation session is never
  fresh, `reauthenticate` refuses it, and its lifetime is bounded by `maxMinutes` and by
  `authn.session.expiration.maxLifetime`.
- **Audit.** Each event goes to every sink, one at a time, each bounded by `authn.audit.sinkTimeoutMs`
  (default 2000). A sink that fails or times out is logged by error class only and never fails a login.
- **Boot.** Services that read config are per child container, so a child boot reads its own list.
- **Per-request credentials count failures only (K5).** See the K5 subsection below; the parallel-load
  401s N1's final review found are gone.
- **Ops notes.** The clock-skew tolerance is 30 s. A session lives 480 minutes when no maximum is
  configured. A store failure right after a session issue or elevation can leave an orphan session
  that no one holds the id of.

### N2: sessions

- Session ids have 128 bits and are stored as SHA-256. Only a lowercase UUID v4 input falls back to a
  raw lookup, so a 2.x session survives the upgrade (SR-18).
- A pending session (after the password, before MFA) lives `authn.session.pendingTtlSeconds` (300 s),
  is never extended, yields no principal and cannot be activated through `set`.
- Banning or deactivating an impersonator ends the impersonation (SR-06).
- The cookie is `Secure` and `__Host-` prefixed unless the app env is development or test
  (`hostPrefix` and `secure` default to `'auto'`). The flags follow the app env that the deployment
  resolved, not `NODE_ENV=production` alone (SR-16). The boot refuses the public cookie secret outside development and test.
  With no env set, authn treats the deployment as production (N8a, step 6).
- `SlidingCappedExpiration` caps a session at `Creation + maxLifetime` (defaults 30 and 480 minutes).
- The DB session migration is `UserSessionIdHash_2026_10_02_00_00_00`. Deleting a user must call
  `revokeAll`, because 3.0 rows have a null `UserId`.
- Stop 2.x nodes before the first 3.0 node (section 7).

### N3: password (`authn-local`)

- argon2id at the library defaults (64 MiB, t=3, p=4). No cost keys. A test pins the stored prefix
  `$argon2id$v=19$m=65536,t=3,p=4$`. Peak memory is `authn.local.hasher.maxConcurrent` (default 8)
  times 64 MiB. Small hosts lower `maxConcurrent`, never the cost.
- An optional pepper (`authn.local.pepper.secret`, `version`). To rotate, move the old pair into
  `previous`. Its hashes still verify and are rehashed on the next login. An unpeppered 2.x hash
  verifies and is rehashed with the pepper.
- Passwords are never trimmed. Length is 8-128 code points for create, change, reset and login.
  Optional `authn.local.policy.rule` (JSON schema) and `blocklist` (a `PasswordBlocklist` service).
- An unknown login costs the same hash work as a known one (timing). A reset request answers at once,
  with the same body, whether or not the account exists.
- A voluntary change keeps every API token (H32), revokes the identity's other sessions, including
  sessions where it is the impersonator, and rotates the current one. A session that someone
  impersonates cannot change the password. A reset, an admin `set` and an admin expiry revoke tokens
  (`authn.local.reset.revokeTokens`, default `true`). An aged-password expiry keeps them.
- An expired password is stored as the marker `!expired`.
- Password expiry is off by default (`authn.local.expiration.enabled: false`, `maxAgeDays: 31`).
  `users` no longer turns it on (C1).
- CLI: `authn:password <login>` (the password from `--generate` or standard input, never an argument)
  and `authn:password-expire` (the expiry job). They replace `user:password`.
- Redeeming a reset on an invite-pending identity also publishes `invite.redeem`. `users` activates
  the account on it.
- Reset calls without a client IP share one `ip: unknown` throttle bucket. `authn-http` passes the IP
  from the trusted proxy chain, so set `http.trustProxy` behind a proxy.
- Reset and invite mails go out through a `PasswordMailer`, which renders and sends at once and never
  queues the secret (SR-09). `users` registers `EmailPasswordMailer` (`@spinajs/email`) unless the app
  registered its own.

### N4: authn-orm

- Tables: `authn_identity`, `authn_throttle`, `authn_audit`, `authn_secret`, `authn_mfa`,
  `authn_recovery_code`, `authn_nonce`. Migrations `AuthnInitial_2026_10_02_00_00_00` and
  `AuthnFromUserMetadata_2026_10_02_00_01_00`.
- The upgrade needs `authn.mfa.encryptionKey` only when some user has a 2FA secret to carry. The design
  said it always refuses without the key.
- It runs an independent census, compares sets (not counts), re-scans for leftover security keys and
  rolls back on any failed check.
- Throttle keys are an HMAC under `authn.audit.hashKey.secret`. Time always comes from Node, never SQL
  `now()`.
- The audit sink never fails on event content. An identity that does not fit goes into `data`.
- Reads check identity, step, purpose, provider and subject for exact equality in Node, because MySQL
  and MSSQL collations ignore case.
- Recovery codes are unsalted SHA-256, so codes need at least 80 bits.
- `DbSecretStore.redeem` costs the same for an unknown identity as for a wrong secret.

### N6: tokens (`authn-token`)

- `spt_` plus 32 random bytes, stored as SHA-256, plaintext shown once. Every token has an expiry:
  at most `authn.token.maxTtlDays` (90) for `pat` and `service` kinds, and
  `authn.token.agentMaxTtlMinutes` (1440) for `agent`.
- A token length below 32, an empty prefix, or a token over 1024 characters fails boot.
- Token roles reach the principal as `ceiling.roles`, never as identity roles. `roles: []` is refused
  at creation. Agent tokens carry no roles.
- Every use checks expiry, revocation, the owner's status (through `IdentityStore`) and the profile.
  Revoking keeps the row (`RevokedAt`), and `list` hides revoked rows.
- Tokens without an expiry get `CreatedAt + maxTtlDays` at migration. The migration is
  `AuthnTokenScope_2026_10_02_00_00_00`.
- The CLI is renamed: `authn:token-create`, `authn:token-delete`, `authn:token-delete-expired`. The
  plaintext of a new token goes to standard output only, never to a logger. `authn:token-create`
  without `--expires` uses `authn.token.defaultTtlDays`.
- `authn.jwt.issuers` enables JWT bearer. A JWT never sets `emailVerified`. An unknown subject fails
  unless both `authn.linking.jit` and the issuer's own `linking.jit` are on (K6; both default off). The
  default provider name is `jwt:<issuer>`.
- The 2.x token API is gone (R1).
- Hooks: `TokenOwnerResolver` (default `UsersTableTokenOwnerResolver`, user owners only),
  `TokenProfilePolicy` (default `NoTokenProfilesPolicy`: no profile allowed, as in 2.x) and an
  optional `RoleSource`.
- The routes (N8b): `GET /user/tokens` lists the caller's tokens that are not revoked, expired ones flagged; `POST /user/tokens` needs
  `expiresAt` (at most `maxTtlDays` ahead) and fresh auth, and answers the plaintext once
  (`Cache-Control: no-store`); `DELETE /user/tokens/:uuid` revokes. A token or key caller gets 403
  `session_required`. `GET /user/tokens/roles` and `/profiles` moved to `users-http`.

### N7: keys (`authn-keys`)

- Ed25519 and P-256 public keys only. The algorithm comes from the key record, never from a token. See
  the [authn README](../authn/README.md#keys).
- Challenge signing input, assertion `iss`, HTTP signature rules and the `authn.keys.*` keys are
  documented in `packages/authn-keys/README.md`.
- A registered key needs `authn.keys.assertion.audience` for `keys-jws` and `authn.keys.challenge.audience`
  (or the assertion audience) for challenges.
- Build `SignedRequest.targetUri` from the configured public origin, never from `Host`.

### N10: OIDC (`authn-oidc`)

2.x had no OIDC, so there is nothing to convert. Config, routes, presets and limits are in
[OIDC](../authn/oidc.md). What an app must do to use it:

- Import `@spinajs/authn-oidc`. Its bootstrapper registers one strategy service per provider, named
  `oidc:<name>`. List each as `{ name: 'oidc:<name>', service: 'oidc:<name>' }` in `authn.strategies`.
  The controller scan alone does not register them.
- Register the redirect URI `<origin>/auth/oidc/<name>/callback` exactly at the provider.
- It needs the tables `authn_nonce` and `authn_identity` from `authn-orm`, a `SessionIssuer`, and
  `AuthnService`.
- Renaming a provider unlinks its users, and so does changing the subject mapping.
- The OIDC routes read `req.storage.ClientIp` and `req.storage.AuthnSession`, which `authn-http`
  writes, so import `@spinajs/authn-http` too.
- Both linking switches must be on, the global `authn.linking.*` and the provider's own; the JIT
  switch for OIDC no longer opens JWT provisioning (K6).

### K4 and K5: test kit fixes and per-request throttling

- **K5.** Strategies that take a credential on every request (`TokenStrategy`, `JwtBearerStrategy`,
  `JwsAssertionStrategy`, `HttpSignatureStrategy`: those with `interactive === false`) no longer count
  an attempt before they verify it. The service first asks the throttle whether a delay holds (`peek`,
  which counts nothing), verifies, and counts only a failure. Many parallel calls with a valid token or
  key now all succeed; repeated bad tokens or signatures still back off, per credential and per IP.
  Interactive logins (password, MFA) still count before they verify (A05).
- A success clears the answering credential's account key and takes only its own failures off the IP
  key, so a valid API call cannot wash out failures other credentials left on the same IP.
- A throttle without `peek` keeps the old count-before-verify flow, and the boot warns when a
  per-request strategy is listed. `MemoryAuthnThrottle` and `DbAuthnThrottle` both have `peek`; a
  throttle of your own should add it.
- Trade-off: peek and count are two steps, so a parallel burst of failures is verified in full and adds
  one backoff step. That is safe only because per-request credentials are unguessable (256-bit tokens,
  signatures); do not put a guessable credential behind a per-request strategy.
- K6 settled the point K5 left open: the account key of a per-request credential is
  `request:<credential id>|<ip>`, so a client that knows a key id can slow that key only from its own
  address. The frozen doc comments of `AuthenticationStrategy.throttleKeys` and
  `AuthnThrottle.attempt` describe the new flow (RFC K5-1).
- **K4.** Test kit only (`@spinajs/authz-testing`): the kit's filter evaluation now coerces values the
  way the engine does, RBAC worlds compile the RBAC native ops, and `FakeTupleModel` has `summarize`, so
  kit worlds can test `covers`. No app change; an app that runs the kit's behaviour rules against its own
  models may see different results.

### SEC1: metadata guard

- Keys with the prefixes `2fa:`, `user:2fa:`, `user:pwd_reset:`, `user:pwd:`, `user:login:`,
  `user:ban:` and `user:invite:` are reserved, after case, width, accent and invisible-character
  folding. They are hidden on every metadata route, and a write to one is a 400.
- A missing, foreign or reserved entry answers 404 on get, PATCH and DELETE in both route families.
  Before, a get raised an unmapped error, and PATCH and DELETE of an absent entry answered 200 and
  did nothing.
- The admin PATCH takes the key as a plain parameter, not as a model lookup.
- This fixes SR-01 and SR-02 (reset tokens and TOTP secrets readable through the metadata routes).

### P1 to P4: test and regression fixes

No app change from P1 to P3 (test isolation and `types` conditions in `exports` of `intl` and
`reflection`). P4: the `__Host-ssid` rename logged tests out; tests now read the cookie name from the
session cookie builder. Clients that hard-code `ssid` need the same fix. For local http, name the env
(`APP_ENV=development`).

### L1b: ladders, rules, tags, links

No 2.x app needs these; the keys and a sample are in [the authz README](./README.md#the-rbac-model).
What an app sees:

- `ConfigRuleStore` reads `authz.rbac.rules` and is the default rules store. Rules in config with no
  `ConfigRuleStore` in `authz.rbac.stores.rules` fail boot.
- A rule's `expiresAt` is a `Date` (in a JS or TS config file) or a date-time string with a zone, such
  as `2027-01-01T00:00:00Z`. A string without a zone fails boot.
- `registerRbac(container, configuration)` wires the stores, the model and `RbacService`; the app calls
  it ([Wiring the models](./README.md#wiring-the-models)). Bind its `linkResolver` as authz-http's
  `LinkResolver`, or share links open nothing.
- An expired link comes back with its `expiresAt`, and the ceiling denies it (`link_invalid`).

### L4 and L4b: ORM adapter, rules in SQL

The decorators, the policy rules and what the middleware cannot see are in
`packages/authz-orm/README.md`. What an app sees:

- `@AccessResource`, `@Owner`, `@ScopeColumn`, `@OrmScope` with `OrmScopePolicy`, `registerAccessResource`,
  `filterFields`, `ownsBy` and `DbDecisionAudit` (`@spinajs/authz-orm/audit`) are built.
- Register `@AccessResource` models before the domain boots, also models that only migration files
  declare. A type registered after boot makes every check on it throw `AuthzConfigError` until the
  domain boots again (E2).
- Queries without a principal on a scoped model throw `AccessDenied`. Raw SQL, views and DDL are not
  scoped. A builder runs only for the principal it was built for.
- Rules compile to SQL for lists (B44). Boot rule 11 refuses, on types whose lists run in SQL, a grant
  pattern that is a glob SQL cannot express (more than a fixed prefix and one trailing `*` or `**`) and
  a config rule whose `resource.*` read SQL can only treat as unknown. A config that booted before L4b
  may now fail here; the message names the rule or the grant.
- Rules over the stored rule tables use `WITH … AS MATERIALIZED`: PostgreSQL 12 or SQLite 3.35 at the
  least. On SQLite such lists are slow (about 0.45 s per filtered row with four stored rules), so they
  suit tests and small tables only.
- PostgreSQL must run with `jit = off` for the app's role or database (G7); authz-orm refuses a
  connection with JIT on unless `authz.orm.allowJit: true`.
- An `@OrmScope` on a model without `@AccessResource` logs a warning at boot (O2): such a model is never
  checked. Several `authorizeCreate` policies OR-ed on one insert are each tried before the insert is
  refused.

### L6: queue (`authz-queue`)

- Importing the package stamps `Initiator` on emitted messages and runs every handler under `runAs`.
  A handler runs unattended unless its job says `@Job({ runAs: 'initiator' })` or `'system'`.
- The import registers `QueueChangeBus` as the default `ChangeBus` (`authz.bus.service` picks another),
  `JobModel` as the resource `job` with the relation `initiator`, and a configuration source that grants
  the `user` role `job:read` on its own jobs. Installing the package without importing it adds nothing,
  so boot no longer fails with `UnknownPermission 'job:read'` (F8). Import it before the
  `Configuration` resolves.
- The default `InitiatorPrincipalFactory` rebuilds the principal from the stamp alone and warns once
  (`authz.queue.stampedInitiatorWarning: false` silences it). `import '@spinajs/users/queue'`
  registers one that reloads the user: a user deactivated, banned or deleted since the job was queued
  runs it unattended.
- The stamp carries no `onBehalfOf` or `authn` facts. A delegated or impersonating principal is not
  stamped, so its jobs run unattended.
- authz-queue pins `@spinajs/queue`; a mixed rollout upgrades consumers before emitters.

### L7: authz-fs

The config, permissions, owners, signed URLs and the `fs` domain are in `packages/authz-fs/README.md`.

- A file system with no `authz.fs.<name>` entry, or `mode: 'off'`, is the raw provider. An entry must
  state `mode`; an unknown key fails boot through the `authz.fs` schema (`InvalidConfiguration`).
- Import the package before `fsService` resolves, and take providers after it resolved: until then
  `fsService` publishes the raw providers.
- Owners live in the table `fs_object` (`OrmFileMetadataStore`, migration
  `AuthzFsObject_2026_10_01_00_00_00`, connection `authz.fsMetadata.connection`).

### K1, K1b and A4: canvas conformance, ABAC scope leaves

No change for a 2.x app. Canvas runs RBAC and ABAC with the config of design §8.5 and writes every fact
through `AuthzAdmin`. A4 adds `authz.abac.scopeResiduals` (default `false`). Off, an ABAC comparison of `scope.<type>.*`
on a list cannot be decided: a deny policy denies the list (`needs_subject`, B19), and a permit makes
the vote indeterminate, which denies it too (B39). On, the comparison becomes a SQL leaf and the list
is filtered row by row ([the authz README](./README.md#the-abac-model)). Canvas turns it on. In either mode, a policy that folds while it
still holds a `scope.*` read that no leaf covers now needs the subject, so such a list is narrower than
before.

### E2 and E3: engine fixes

- An intersect agent's row checks narrow to its delegate's list (reason `delegate`).
- A resource type that an adapter lists only after the domain booted is refused (see L4).
- E3: no app change. A native compiler for an op whose `NativeFilter` declares `principalInArgs` must
  not read its `principal` argument (`packages/authz-orm/README.md`).

### N5: authn-totp

The full description is in the [authn guide](../authn/README.md#the-totp-step-authn-totp).

- **TOTP is opt-in.** The package lists no step and no key. Add `{ name: 'totp', service: 'TotpMfaStep' }`
  to `authn.mfa.steps`, set `authn.mfa.encryptionKey.secret` (64 hex characters, or base64 or
  base64url of 32 bytes), `import '@spinajs/authn-totp'` and `import '@spinajs/authn-totp/db'` once.
  Keep the old key in `authn.mfa.encryptionKey.previous` on rotation. The converter writes the step
  entry and leaves the key and the imports to you.
- **Importing `@spinajs/authn-totp/db` runs the authn-orm data migration** (on an Orm that migrates at
  start-up): 2.x TOTP secrets move into `authn_mfa`, and the 2.x `2fa:*`, `user:2fa:*`, `user:login:*`
  and `user:pwd_reset:*` metadata is deleted.
- With the `totp` step listed in `authn.mfa.steps`, a user with 2.x 2FA enabled never logs in with the
  password alone. **With no step listed, `DefaultMfaPolicy` asks for none, and such a user logs in with
  the password alone:** list the step before the first 3.0 start if any user has 2.x 2FA.
- **`rbac:user-enable-2fa` is gone.** It printed a secret. Use `authn:mfa-reset <login>`; the owner
  enrols again through `/user/mfa`.
- **Recovery codes** are 16 base32 characters shown as `XXXX-XXXX-XXXX-XXXX`, 80 bits each, ten by
  default (`authn.mfa.totp.recoveryCodes`, at most 100), returned once.
- **Throttle.** Confirming and disabling count into the `mfa` throttle, in the same budget as the
  login. Pick the `mfa` limits with that in mind.
- `User2FaEnabled` and the other 2.x 2FA queue events are gone; listen for `mfa.enrol` and
  `mfa.disable` in an `AuthnEventSink`.
- Known limits: parallel regeneration can leave two live recovery-code sets (the store has no
  transaction), and `TotpService` finds the MFA steps in the root container.

### N8a, N8b and N8c: authn-http

The 3.0 HTTP layer replaced the 2.x one in one switch (N8c). The release notes list every route, body
field and error code a client sees. For an app:

- **Middleware.** `ClientIp` (Order 1), `CsrfOriginGuard` (Order 4) and `AuthnMiddleware` (key, token
  and session credentials) run before authz-http's `PrincipalMiddleware`. `AuthnMiddleware`
  writes `req.storage.AuthnPrincipal`, which authz-http's `AuthnPrincipalSource` reads.
  `req.storage.Session` and `req.storage.ActiveRole` are never set.
- **Import order.** `import '@spinajs/authn-http'` at the top of the app entry. When only the
  controller scan loads it, it comes too late and no request is authenticated.
- **Route groups.** Each group answers 404 `not_found` until its service is registered: password
  (`authn-local`), MFA (`authn-totp` imported, the `totp` step listed and the key set), tokens
  (`authn-token`), keys (`authn-keys` plus `authn.keys.assertion.audience` or
  `authn.keys.challenge.audience`), credential admin (a `CredentialAdminGuard`, which users registers).
- **Fresh auth** runs in the handler: a session older than `authn.freshAuth.maxAgeSeconds` sends the
  password as `reauthPassword` in the body (403 `fresh_auth_required` without it). An identity without
  an email cannot re-authenticate inline: the login is taken from `IdentityStore.display(id).email`.
- **Role switch** asks the password for every role unless `authz.principals.roleSwitch.requirePassword`
  lists the roles that need it.
- **Impersonation** needs an actor session at `aal2` (`authn.impersonation.requireMfa`, default
  `true`) and fresh auth (`requirePassword`, default `true`). The actor is judged again on every
  request; impersonators lose `/user/sessions`.
- **Sessions.** The cookie is a browser-session cookie (no `Max-Age`); idle and absolute timeouts are
  enforced on the server. 2.x session rows that carry an `ActiveRole` are revoked on first use; the
  others migrate to hashed ids. Truncate the session store of a staging system that ran earlier 3.0
  builds. `authn.strategies` must list the strategies (`local` → `LocalPasswordStrategy`); without one
  the login answers 401.
- **Signed requests** need a JSON body or none: only JSON keeps the raw bytes the digest needs.
- A key login is `aal1` and asks no MFA step under the default policy; after fresh auth such a session
  can mint tokens and register keys, as a password session of an identity without MFA can.
- Build trees: after pulling, run `npm run clean`; an incremental build keeps the old 2.x controllers
  in `lib/`, and the shipped scan would mount them.

### C1, C2, C2b, C3 and C3b: users and users-http

- users implements authn's ports: `UserIdentityStore`, `UserPasswordStore` (compare-and-set),
  `UserPasswordAgeSource`, `UserPrincipalFactory`, `UserAccountStatusSource`, `QueueAuthnEventSink`,
  and the authz-backed hooks `AuthzImpersonationGuard`, `AccessResponseExtension`, `RbacRoleSource`
  and `AuthzCredentialAdminGuard`. `import '@spinajs/users'` registers them.
- `QueueAuthnEventSink` re-emits `UserLogged`, `UserLoginFailed`, `UserPasswordChanged`,
  `UserPasswordExpired`, `UserPasswordChangeRequest`, `UserImpersonationStarted` and
  `UserImpersonationEnded`. A redeemed invite no longer emits `UserPasswordChanged`; `create()` with a
  password does. `LastLoginAt` is no longer written.
- `User.Role` is gone; users ships no `rbac.*` key, no password-expiry switch and no cookie override.
  Its `user` role reads `Email` and `Login` of its own record; `admin.users` holds `users:*`.
- `users` does not verify stored emails, so keep `authn.linking.byVerifiedEmail` off with its store.
- users-http routes sit on `@Access('users:<action>')` (admin) and `@Access('user:read')` (own
  record). `GET /user/refresh` is `GET /user`; `@User()` is `@CurrentUser()`. `/user/grants` and the
  2.x credential routes under `/users/security` answer 404; the credential routes moved to
  `/authn/admin/users/:uuid/*` (authn-http).
- `GET /users/roles` answers the roles the caller may assign, by a dry run through `AuthzAdmin`.
  `Role` is a filter but no longer a sort column. `POST /users` answers `Incomplete: { resendInvite }`
  when a step after the role grants failed.
- Deactivate, ban and delete need fresh auth and the credential admin guard (`users:credentials`, a
  target the caller covers, no protected role), then users-http's `AccountGuard`, which replaces
  `rbac.admin.roleGuard` and reads `authz.admin.guard`. A changed `Email` or `Login` needs fresh auth
  too. Metadata lists sort by `Id`, `Key` or `Type` only. The full list is in
  `packages/users-http/README.md`, "Breaking changes in this release".

### C4: authz-http-admin

`/authz/*` routes over `AuthzAdmin` ([the authz README](./README.md#authzadmin)). **An app with the
package installed serves them.** The routes check only that the caller is signed in; every permission
and guard check runs inside `AuthzAdmin`.

### C5 to C9: consumers

- **C5, token principals.** `authz.token.excludedRoles` and `authz.token.rolePolicy` apply to every
  principal with `authn.method: 'token'`, in checks, lists, summaries and `covers` alike. An unknown
  policy name fails boot.
- **C6, configuration-http.** Its routes need `configuration:read` or `configuration:update`
  (`admin.configuration`, which `admin` extends). In an app where authz guards the config model,
  `configuration-db-source` persists and polls as `SYSTEM`, and only after the HTTP server listens.
- **C7, telemetry and swagger.** A telemetry slot set to `'AccessPolicy'` checks
  `telemetry.auth.permissions.<endpoint>` (default `telemetry:read`). `telemetry.auth.token` still works:
  a bootstrapper turns it into `service:telemetry`. The development bypass needs
  `telemetry.auth.skipInDevelopment: true` and an env that names development. Swagger shows
  `x-authz-permission` and `x-authz-resource` instead of `x-rbac-*`.
- **C8, job status.** `GET jobs/v1/:jobId/status` answers 404 for an unknown job and for a job the
  caller may not read (2.x answered 200 `queued` for an unknown id).
- **C9, electron, email, log.** IPC calls run as `SYSTEM` (`electron-ipc`). Email reads attachments as
  the sending principal and never queues a secret; `EmailSend` runs as its initiator. Log lines carry a
  `Principal` field (`type:id`). The details are in the release notes.

### G2 and G2b: admin and account guards

- `DefaultAdminGuard` follows `PermissionDef.implies` and expands glob grants through the permission
  registry when it decides whether the actor covers a role.
- Its `last_holder` check counts only holders that an `AccountStatusSource` reports in service (users
  registers `UserAccountStatusSource`). An app with its own identity store registers one, or the check
  counts out-of-service accounts and logs a warning.

### K6: authn core fixes

- `ExternalLoginHook`s run before the session is issued; a hook that throws fails the login with the
  opaque answer (audit reason `hook_error`).
- JIT and email linking need the global switch and the strategy's own: the OIDC provider's
  `linking.*`, or a JWT issuer's `linking.jit`.
- Per-request backoff keys on the credential and the IP (K5 above). `authn.throttle.service` may stay
  unset with `authn-orm` imported.

### R1: removal of the 2.x code

- Every 2.x module, policy, decorator and `rbac.*` default is gone from `packages/*/src`.
  `authz.config.rejectLegacyKeys` and `authn.config.rejectLegacyKeys` default to `true`: a `rbac.*` key
  fails boot.
- `rbac.roleSwitch.requirePassword` is not read any more, not even as a fallback; set
  `authz.principals.roleSwitch.requirePassword`.
- Kept on purpose: table and migration names, the 2.x metadata key names (hidden and protected), 2.x
  session rows (migrated on first use), and the names `RbacException`, `RbacCliCommand`,
  `RbacBootstrapper`, `RBAC_USER_MODEL`, the `rbac:user-*` CLI commands of users, `rbac:2fa-qr` of
  authn-totp, and the `rbac*` logger and queue names.
- `getRegisteredTypes` answers `null` once no container in the lineage holds a registration of the
  type, also after every registration was removed; callers treat it as none (Z5).

### Z1 to Z7: fixes found late

- **Z2.** authn-orm's nonce model is `AuthnNonceModel` (it clashed with authn-keys' `AuthnNonce`); the
  table name is unchanged.
- **Z3.** `@spinajs/orm` quotes join keys, MSSQL table aliases, `ORDER BY` and `MERGE` columns, and
  recursive CTE column lists with the driver's quoter (brackets on MSSQL, double quotes on PostgreSQL).
- **Z4 and Z6.** A 400 or a log line never carries a request value. `ValidationFailed` takes
  `(message, errors, schema?)` and has no `data`; `details[].value` is gone. Query values are redacted in
  HTTP log lines. A body that fails the parser's `verify` hook answers 400, not 500. The release notes have the full list.
- **Z5.** A child container that unregisters its last entry for a key now falls back to the parent's
  entries (before, it resolved to an empty list). A controller override without its own `@Access` keeps
  the inherited one.
- **Z7.** Test fix only.

### T1 to T4, O2, KT1 to KT3, F8, Q1: test ports and kit fixes

No app change beyond what the subsections above say. The 2.x tests are ported or closed as each
package's `test/LEDGER.md` records.

## 10. Security fixes an app sees

The 2.x authentication review found 0 critical, 3 high, 9 medium and 8 low findings (SR-01 to SR-20).
There is no 2.x patch (H34): the fixes are in 3.0, each with a regression test that replays the 2.x
attack. **The high findings SR-01, SR-02 and SR-03 stay exploitable in released 2.x until the app
upgrades.**

| Finding | What an app sees in 3.0 |
|---|---|
| SR-01, SR-02 | Metadata routes hide and refuse reserved keys. Security state no longer lives in `users_metadata`. |
| SR-03 | Backoff on every authentication flow, per account and per IP. `http.trustProxy` decides where the client IP comes from. At most `maxConcurrent` argon2 operations run at once. |
| SR-04 | An unknown login takes as long as a known one. A reset request answers before the work runs. |
| SR-05 | Interactive attempts (password, MFA) are counted before verification, atomically. Per-request credentials count failures only (K5). Nobody can lock the owner out. |
| SR-06 | An impersonation ends when the impersonator is revoked, and after `authn.impersonation.maxMinutes`. |
| SR-07 | A session between password and MFA yields no principal. |
| SR-08 | A reset revokes API tokens. Minting a token needs fresh auth and an expiry of at most `authn.token.maxTtlDays` (90). |
| SR-09 | Reset secrets are SHA-256 at rest. TOTP secrets are AES-256-GCM at rest, and recovery codes are SHA-256 only. |
| SR-10 | `TotpService.adminReset` and `authn:mfa-reset` return no secret. The credential admin routes (`/authn/admin/users/:uuid/*`) need `users:credentials`, a target the caller covers, no protected role on the target, and fresh auth. |
| SR-11 | An audit trail (log and database) is on by default. `DbAuthnAuditSink` stores raw subject refs, IP and user agent. |
| SR-12 | The CSRF origin guard checks every cookie request with an unsafe method, and CORS with an empty list allows nothing (step 8). |
| SR-13 to SR-15 | argon2 defaults pinned and rehash on login. No trimming, one length limit. A TOTP code works once, and an older time step is refused (`TotpMfaStep`, SR-15). |
| SR-16 | Cookie flags and secret checks follow the app env, not `NODE_ENV=production` alone, and a missing env counts as production. |
| SR-17 to SR-20 | An opaque error for a missing reset. Session ids hashed. `LogAuthnAuditSink` logs keyed hashes of identifiers (the database sink does not). Re-authentication counts into the throttle. |

## 11. Open items in 3.0.0-rc.1

Known gaps an app may meet. None of them widens access.

- **No queue sink for authz events.** `RoleAssigned` and `RoleRevoked` reach only the registered
  `AuthzEventSink`s, and only `LogAuthzEventSink` ships. A subscriber of the 2.x `UserRoleGranted` or
  `UserRoleRevoked` queue events needs an `AuthzEventSink` of the app's own that emits them.
- **The app wires the RBAC and ABAC models** ([the authz README](./README.md#wiring-the-models)). No
  package registers them from config.
- **`DefaultAdminGuard` without an `AccountStatusSource`** counts out-of-service holders for
  `last_holder` (with a warning). Apps on users get `UserAccountStatusSource`.
- **Last-holder checks are not serialised.** Two concurrent changes that each take a different last
  holder of `privilegedPermission` out of service (through `AuthzAdmin` or users-http's
  `AccountGuard`) can both pass (G2b).
- **A deferred mail whose attachment read is refused** is retried like any failed job, although the
  answer stays the same.
- **`authz-fs` exports a mirror `FsDecorator`** from its frozen `api.ts`; `@spinajs/fs`'s class is the one
  `fsService` resolves.
- **HTTP log redaction** covers query values, not secrets in a URL path (`/verify/<token>`) or short
  query keys. Some body-parser errors (too large, charset, parameters) still answer 500.
- **OIDC** has no run against a real Keycloak yet (lane IC2).
- **SQLite lists over stored rules** suit tests and small tables only (section 9, L4b).
- **`configuration-db-source`** in a guarded app starts persisting and polling only once the HTTP
  server listens; a worker without an HTTP server waits.

The `npm deprecate` pointers for the five 2.x package names (`@spinajs/rbac`, `rbac-http`,
`rbac-http-user`, `rbac-http-admin`, `rbac-http-token`) are set at `3.0.0` final (H25).
