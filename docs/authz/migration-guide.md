# Migrating from SpinaJS 2.x to 3.0: authorization and authentication

This is the one guide for both families. 3.0 splits `@spinajs/rbac` into identity (`users`),
authentication (`authn`) and authorization (`authz`). There is no compatibility mode and no 2.x
maintenance branch (H6, H11). You change config, imports, decorators, runtime checks and clients in
one step, and the database in another.

Related documents:

- [Authorization in 3.0](./README.md)
- [Authentication in 3.0](../authn/README.md) and [OIDC](../authn/oidc.md)
- Design: `docs/plans/2026-10-01-authz-v3-design.md`. Rule numbers (H1, B24, A31, SR-01) point there.

Some lanes of the 3.0 work have not merged. Each gap in this guide is a `TODO(<lane>)` block. It keeps
its heading, so the release lane can fill it in.

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
11. [Parts not built yet](#11-parts-not-built-yet)

## 1. Who must read this, and what changes

Read this if your app depends on any of `@spinajs/rbac`, `rbac-http`, `rbac-http-user`,
`rbac-http-admin` or `rbac-http-token`, or reads `rbac.*` config.

What bites, on one screen:

| Change | What you see | What you do |
|---|---|---|
| **Union of roles (H1)** | A user with several roles gets the grants of all of them. 2.x mixed the active role and all roles. A role switch now only narrows. | Before the data migration, list users with several roles (step 5). Decide that the union is meant. |
| **Unattended work is denied (H2)** | CLI commands, cron jobs, queue handlers, `@Task` bodies, sockets without a user and config polling have no principal. Every check denies them, and a query on a scoped ORM model throws. | Wrap the entry point in `authz().runAs(SYSTEM, 'reason', fn)`, or run the job as its initiator (step 4). |
| **`users.Role` is dropped (H13)** | The column is copied into `authz_assignment` and then removed. Raw SQL and `User.Role` stop working. Rolling back to 2.x needs the `down()` of the drop migration first. | Remove every read of the column. Back up first (step 6). |
| **Empty CORS list allows nothing (H33, A31)** | 2.x answered every origin, with credentials, when `http.cors.origins` was empty. 3.0 sends no CORS headers. | List every origin a browser client uses (step 8). |
| **No lockout (H31)** | Accounts are never locked. Failed logins back off per account and per IP, up to a cap. `lockoutTime` is gone. | Tune `authn.throttle.login` if the default is too weak. |
| **Session cookie `__Host-ssid`** | Outside development and test the cookie is named `__Host-ssid`, with `Secure`. Every 2.x session is logged out at the upgrade. Clients that hard-code `ssid` break. | Change such clients. For local http set `authn.session.cookie.hostPrefix: false` in a development config. `secure: false` alone no longer relaxes the cookie. |
| **Resets and invites carry over (H35)** | Pending password resets and invites become hashed `authn_secret` rows with their 2.x expiry. A link already mailed works once. `down()` cannot restore them. | Nothing, unless you roll back. |
| **No re-export shims (H25)** | The old npm names stop at 2.x. They get `npm deprecate` and nothing else. | Change dependencies and imports (step 1). |
| **`rbac.*` config is not read** | The host warns, or fails boot with `authz.config.rejectLegacyKeys: true`. | Run the converter (step 2). |
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
| `rbac.admin.roleGuard.*` | `authz.admin.guard.*` | `DefaultRoleGuard` becomes `DefaultAdminGuard`. `privilegedResource` and `privilegedAction` become `privilegedPermission: 'users:update'`. A custom guard is written as found; boot fails until you port it. |
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
| `rbac.twoFactorAuth`, `rbac.otpauth.*` | `authn.mfa.steps`, `authn.mfa.policy.force`, `authn.mfa.totp.*` | `forceUser` becomes `policy.force`. |
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
| Public cookie secret `'1234adreewD'` | Boot refuses a public or missing secret outside development and test | Listed. |
| Empty `http.cors.origins` reflects every origin | Allows none (H33) | Listed. |
| No `http.trustProxy` | Set the hop count or CIDRs behind a proxy | Listed. |

### 3.4 Keys that other config files own

- `http.cors.origins` and `http.trustProxy` stay under `http.*`. `http.trustProxy` is a hop count or a
  list of CIDRs. It makes the client IP, which throttling and audit use, come from the proxy chain.
- `authn.http.csrf.allowedOrigins` lists origins that may send cookie-authenticated unsafe requests.
  The app's own origin is always allowed.

> **TODO(N1): `authn.*` core config as built.** Fill in the boot checks, the old-key detector
> (`authn.config.rejectLegacyKeys`) and `authn:check-config` when N1 merges. The AJV schema already
> fails boot on `token.length` below 32, an empty `token.prefix`, `totp.digits` below 6, password
> bounds outside 8-128, `session.hashIds: false` and an `mfa.steps[].name` of `recovery`.

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
- It runs the config a second time in a child process under the other `NODE_ENV` and `APP_ENV`. It
  lists every value that changes. The converted files hold the values of one run. It also names
  files that read other environment variables.
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

The converter names a user by `Login`, else `Id`. On PostgreSQL you can build the file in one query
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

The status column says whether the 3.0 side is built in the code merged so far.

| 2.x | 3.0 | Status |
|---|---|---|
| `@Resource('X')` + `@Permission(['readAny','readOwn'])` | `@Access('X:read')` | built (`authz-http`) |
| `@Policy(TokenPolicy)` above `@Permission` | delete the line; `@Access` accepts token principals | built |
| `@Permission(['updateOwn'], TwoFactorAuthEnabled)` | `@Access('user:update', { also: [TwoFactorAuthEnabled] })` | built |
| `@SkipModelPermission()` | `@Unscoped('reason')` or `authz().runAs(SYSTEM, 'reason', fn)` | built |
| `user.canReadAny('X').granted`, `checkUserPermission`, `probeGrant`, `checkRbacPermission` | `await authz().can(authz().current(), 'X:read')` | built |
| `permission.filter(data)` | `filterFields(decision, data, 'read')` | TODO(L4) |
| `PermissionService`, `ResourceRules<T>.owns()` | a `RelationResolver`, or `ownsBy(type, relation, fn)`, plus `authz().assert(...)` | TODO(L4) |
| `@OrmResource`, `@ResourceOwner` | `@AccessResource`, `@Owner` | TODO(L4) |
| `@OrmPermission(M, 'x') class P extends OrmPermissionPolicy` | `@OrmScope(M, 'x') class P extends OrmScopePolicy` with `scope(query, principal, op)` | TODO(L4) |
| `effectiveRoles(user, storage)`, `req.storage.ActiveRole` | `principal.ceiling?.roles`; `RbacService.rolesOf(principal, at)` | built |
| `grant(user, role)`, `revoke`, CLI `rbac:user-grant` | `AuthzAdmin.assign(actor, ...)`, `revoke`; CLI `authz:assign`, `authz:revoke` | `AuthzAdmin` built; CLI TODO(L2) |
| `GET /grants`, `/user/grants`, `Grants` in login | `GET /user/access`, `Access` in login, `POST /user/access/check` | routes built; `Access` in login TODO(C3) |
| `DI.get('AccessControl')`, `import 'accesscontrol'` | removed; use `authz()` and `RbacService` | built |
| `user.Role`, raw SQL on `users.Role`, `withRole` | `RbacService.rolesOf(principal)`, `AssignmentStore.holders(role, scope)`, or a join on `authz_assignment` | TODO(L2) |
| `import { ... } from '@spinajs/rbac'` and the other `rbac*` packages | the new names of section 2 | built |
| `UserRoleGranted`, `UserRoleRevoked` subscribers | `RoleAssigned`, `RoleRevoked` (`subject`, `role`, `scope`, `actor`, `expiresAt`) | TODO(L6) |
| `login(email, password)`, `SimpleDbAuthProvider.authenticate` | `AuthnService.authenticate({ kind: 'password', login, password }, ctx)` | TODO(N1) |
| `passwordChangeRequest`, `confirmPasswordReset`, `changeUserPassword` | `PasswordService.requestReset`, `.redeemReset`, `.change` (`LocalPasswordService` in `authn-local`) | built |
| `SessionProvider`, `UserSession`, `regenerateSession`, `revokeUserSessions` | `SessionProvider` from `@spinajs/authn-session`; `SessionIssuer.rotate`, `.revokeAll(subject)` | built |
| `TwoFactorAuthProvider`, `Default2FaToken`, `auth2Fa` | `MfaStep`, `TotpMfaStep`, `AuthnService.completeMfa` | TODO(N5) |
| `validateToken`, `createToken` | `TokenService.validate`, `.create` (`DbTokenService` in `authn-token`) | built |
| `@Policy(NoTokenAuthPolicy)` | `NoTokenAuthPolicy` from `authn-http` | built (2.x code, moved) |
| `LoggedPolicy`, `AuthorizedPolicy` | `Authenticated`, and `FreshAuth(seconds)` on sensitive routes | contract built; TODO(N8a) |
| metadata keys `2fa:*`, `user:pwd_reset:*`, `user:login:*` | gone from `users_metadata`; see [section 7](#7-data-migration) | built (`authn-orm`) |

Removed with no replacement (§11.5): `@Resource`, `@Permission`, `RbacPolicy`,
`checkRbacPermission`, `checkUserPermission`, `checkRoutePermission`, `GrantsController`,
`IGrantsMap`, `FilterAttribute`, `@SkipModelPermission`, `ACL_CONTROLLER_DESCRIPTOR`, the swagger
`x-rbac-*` keys (use `x-authz-permission` and `x-authz-resource`) and the `orm-api` package.

### 5.2 What the merged HTTP layer adds

- `@Access` on a class and on a route combine with AND. A `@Access` on a subclass replaces the one it
  inherits.
- `@Unscoped(reason)` keeps the principal. The ORM adapter skips the residual, and the call is
  audited once. It needs `@Access` on the same route.
- On a route with `@Access`, body fields outside `decision.fields.write` are stripped (or a 400 in
  `authz.fields.write.mode: 'reject'`), and `authz.fields.neverRead` is stripped from the input.
  **A route that must accept such a field** (an admin route that sets `Password`) needs
  `@UnfilteredInput(reason)`. This applies to `users-http` and `authn-http` routes too.
- `@CurrentPrincipal()` returns the principal. `@User()` still returns the identity record.
- `PrincipalMiddleware` must run after the session middleware (Order 5).
- New `authz.http.*` keys: `services` (header-token service principals), `links`, `explainRoute`,
  `access.domain`. See [the authz README](./README.md#adapters).
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
// 3.0 form from the design; the API is built by lane L4
@OrmScope(Campaign, 'partner')
export class CampaignPartnerPolicy extends OrmScopePolicy<Campaign> {
  scope(q: IWhereBuilder<Campaign>, p: Principal) { partnerManagedWithinPool(q, p.attributes.pool as string | undefined); }
  authorizeCreate(q: InsertQueryBuilder, p: Principal) { q.forceColumn('campaign_management_company', 'partner'); }
  authorizeUpdate(q: UpdateQueryBuilder, values: Record<string, unknown>) { assertStaysInScope('campaign_management_company', [values.campaign_management_company], 'partner'); }
}
```

A separate `QueryMiddleware` that guarded updates (`PolsatCampaignUpdateGuard`) is deleted:
`authorizeUpdate` replaces it.

> **TODO(L4): ORM decorators.** Check the names and signatures above against the L4 report
> (`@OrmScope`, `OrmScopePolicy`, `@Owner`, `@AccessResource`).

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
`decision.reason` to its own errors. (`ownsBy` is part of the ORM adapter: TODO(L4).)

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

If your policy only narrowed the roles a token may carry, keep it as an `AccessTokenRolePolicy` that
returns fewer roles. If it allowed more than the owner holds, remove that part: it cannot work.

### 6.9 Example (h): the frontend

`new AccessControl({ _user: grants })` and `HasAccess(resource, action)` become a check on the access
summary from `GET /user/access`:

```ts
// AccessSummary.permissions: [{ name: 'PrimeSpot:read', conditional: true, fields?: { read, write } }, ...]
const can = (access, name) => access.permissions.some((p) => p.name === name);
```

`conditional: true` means "only rows in scope". Login, MFA, role-switch and impersonation answers carry
the same `Access` object (TODO(C3): the `AuthnResponseExtension` that adds it).

### 6.10 Example (i): pools

Keep `User.Pool` and expose it as `principal.attributes.pool` through a `PrincipalAttributeProvider`.
Per-scope roles (a `salesman` role at `pool:primespot`) can later replace the 14 root roles, but that
is a follow-up, not part of the port.

## 7. Data migration

**Back up the database first.** The `users.Role` drop is the only 3.0 migration that deletes data
(§9.2), and a later `down()` cannot restore every row it touches.

| What | What happens | Needs |
|---|---|---|
| `users.Role` | Copied into `authz_assignment` as `$global` assignments. A second migration drops the column. Its `down()` rebuilds the column from `$global` assignments. | `authz.rbac.migration.roleColumn` if your column is not `Role` |
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
  fully authorised comes back as a *pending* session.
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

> **TODO(L2): `users.Role` copy and drop.** Name the migration classes and the order they run in
> (the design calls them `AuthzRbacUserRoles` and `AuthzRbacDropUserRole`, in the same package, so
> the order is fixed), and the checks the copy makes before the drop. Fill in from the L2 report.

## 8. Steps for an app

### Step 1: dependencies and imports

Replace the packages by the table in section 2 and fix the imports. The old npm names get
`npm deprecate` pointers and no shims (H25). Build. Check: no `@spinajs/rbac*` import is left
(`grep -r "@spinajs/rbac" src`).

### Step 2: config

Compile the app, run the converter ([section 4](#4-running-spinajs-authz-convert)), and copy the
generated files into the config dir. Read `authz-warnings.md` and act on every "convert by hand" item.
Then delete the `rbac.*` keys from your own config files. Check: the app boots with no warning that
names `rbac.*` keys. Note: package defaults still ship some `rbac.*` keys until the identity and
authentication lanes finish, so leave `authz.config.rejectLegacyKeys` at `false` for now (TODO(R1)).

**Impersonation.** Do not delete `rbac.impersonation.protectedRoles` yet.

> **TODO(N8a/C3): impersonation keys.** `authn-http`'s `ImpersonationController` still reads
> `rbac.impersonation.protectedRoles`, and `users/src/config/users.ts` still ships that key. Nothing
> reads `authz.impersonation.protectedRoles` yet, although the converter writes it. Until N8a and C3
> land, keep the 2.x key in the app's config next to the converted one. Replace this block with the
> final key and the `AuthzImpersonationGuard` setup.

### Step 3: decorators

Apply the table in section 5. Most names change by search and replace. `@Permission` lists need the
table: `['readAny', 'readOwn']` becomes `@Access('X:read')`, and the own/any split moves into the
role grants (`relation: 'owner'`). Check: the compiler finds no `@Permission`, `@Resource` or
`@Policy(TokenPolicy)`.

### Step 4: runtime checks and unattended entry points

- Replace runtime checks (`user.can*`, `checkUserPermission`) with `authz().can(...)`.
- Port every `OrmPermissionPolicy` class to an `OrmScopePolicy` (TODO(L4)).
- Add `runAs` where code runs with no principal. List of entry points to check: the user CLI commands,
  `configuration-db-source` polling when its model has `@AccessResource`, session restore and user
  lookup, password reset, `getSystemUser`, migrations and `@Task` bodies that touch scoped models. A
  queue handler runs unattended by default (TODO(L6): `@Job({ runAs })`).
- Remove every read of `users.Role` and `user.Role`.
- Put `@UnfilteredInput(reason)` on routes that must accept a `neverRead` field.

Check: run the app's tests. A missing `runAs` shows as `AccessDenied` with reason `unattended`,
naming the model.

> **TODO(L2): `authz:check-config --unattended`.** The design lists models with `@AccessResource` that
> were queried without a principal in the last test run's audit log. Fill in the command and its
> output from the L2 report.

### Step 5: list the users who gain access

While the `Role` column still exists, find users whose roles will be unioned (H1):

```sql
SELECT Id, Login, Role FROM users WHERE Role LIKE '%,%';
```

The converter lists them too, from the `--db` file. For each, decide that the union is meant. Also
check roles that the config does not define: in 2.x a user holding one got no permission at all
(`accesscontrol` refused the whole list). In 3.0 that role is ignored, with a warning, and the others
apply. Export the `--db` rows now if you did not (section 4.2).

### Step 6: back up, then migrate

Back up the database. Run the migrations. They copy `users.Role` into `authz_assignment` and drop the
column (H13), move TOTP secrets into `authn_mfa` (set `authn.mfa.encryptionKey` first), carry resets
and invites into `authn_secret`, drop throttle state from `users_metadata` and widen
`user_sessions.SessionId`. Check: the migration's own counts match (enrolled users, live resets and
invites). Compare the number of users with a role before and after.

### Step 7: secrets and proxy settings

Set these before the first 3.0 start:

- `authn.mfa.encryptionKey` (a secret reference, never an inline value) if any user has 2FA;
- `authn.local.pepper.secret` (optional; see the authn README);
- a real `http.cookie.secret`, loaded from a secret reference. The boot refuses the public default
  outside development and test;
- `authn.audit.hashKey.secret`, so throttle keys in `authn_throttle` are keyed hashes. Without it a
  public constant is used and the store warns once at start;
- `http.trustProxy`: the number of proxy hops, or their CIDRs. Without it, every client behind the
  proxy shares one address for throttling and audit;
- the app env (`NODE_ENV` or the configuration env) explicitly, in every deployment. The session cookie
  is `Secure`, `__Host-` prefixed, outside development and test.

> **TODO(N8a/N1): the app env when none is set.** One lane resolves a missing env to `development`
> (relaxed cookie, public cookie secret accepted), another to production (SR-16 residual, open in
> the N2 and P4 reports). Replace this note with the final rule.

### Step 8: CORS

2.x answers every origin, with credentials, when `http.cors.origins` is empty. 3.0 then allows no
cross-origin request (H33, A31). List every origin your browser clients use in `http.cors.origins`.
For cookie sessions also list them in `authn.http.csrf.allowedOrigins`. A same-origin app needs
nothing. A listed origin matches exactly (scheme, host and port, with no prefix match) and is echoed
with `Vary: Origin`. `*` is accepted only without credentials. A cookie-authenticated request with an
unsafe method must come from the app's own origin or a listed one, or it gets a 403 (A22).
Check: a browser client on a listed origin works, and one on another origin gets no CORS headers.

> **TODO(N8a): CORS and CSRF middleware as built.** Name the middleware, the config keys and the
> warning in `authn:check-config`. The rule above is fixed by the design (A31, A22).

### Step 9: clients

- Use `Access` (from `GET /user/access`) instead of `Grants`. The `/grants` routes are gone (H7).
- A client that sent the `ssid` cookie by name must send `__Host-ssid`, or it must be moved to a
  login that sets the cookie for it.
- A client that relied on a pending 2FA session to read `GET /auth` or to start impersonation must
  finish the MFA step first (D25). A pending session yields no principal.
- Check password limits in clients: 3.0 accepts 8-128 characters at login and never trims.
- An API client must send the token before it expires. Tokens need an expiry.

### Step 10: run the suite and the config checks

Run the app's tests. Run the config checks when they land.

> **TODO(L2/N1): `authz:check-config` and `authn:check-config`.** `authz:check-config` checks roles and
> grants (the design adds `--explain-role` to list inherited grants). `authn:check-config` checks
> strategies, secrets, proxy and CORS settings. Fill in the commands and what they print.

## 9. Behaviour changes, lane by lane

One subsection for each merged lane, from its report. A line "no app change" means the lane
adds contracts, tests or tools only.

### F0a: package skeletons

No app change. Twenty new packages at `3.0.0-alpha.0`. The 2.x packages stay at their 2.x version.

### F0b: package moves

The moves of section 2. Config files stay in `<pkg>/src/config/`, split by the reader. Identity keys
moved with the same sub-path (`rbac.user.profile` is now `users.user.profile`). Some authentication
keys moved only where the target keeps the shape and meaning of the 2.x value. For a while the
packages still ship `rbac.auth`, `rbac.twoFactorAuth` and `rbac.password.blockAfterAttempts|lockoutTime`
defaults, and read some `authn.*` keys in the 2.x shape (for example `authn.local.hasher.service` is
the 2.x provider name). The converter writes the target shapes. Installing `authn-http` alone now
mounts `/auth/*` and `/user/tokens`. The `TwoFactorAuthProvider` class lives in `authn-totp`, and the
abstract `RoleGuard` lives in `authz-http-admin/src/legacy/`.

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
- `resolveChain` is new. It merges registrations across parent and child containers. Unlike
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
- The `rbac.*` detector warns by default. `authz.config.rejectLegacyKeys: true` fails boot and names
  the converter. The design said "fails boot"; the default is a warning so that packages that still
  ship `rbac.*` keys can boot.
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
- A request without a session cookie is exempt from the CSRF origin check. This includes
  `POST /auth/login`, `POST /auth/keys/login` and `POST /auth/password/reset`.
- Per-request credentials (tokens, keys) count in the `login` throttle flow, keyed by a stable
  credential id (token id, key id). Every API request writes the throttle store twice.
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

### K2 and K3: RFCs L3-1, L9-1 and N3-1

- `PasswordCredentialStore.set(id, hash, expected?)` is a compare-and-set. **A custom password store
  must implement it:** with `expected`, write only when the stored hash equals it (`null` means "no
  password") and answer whether it wrote; without `expected`, write unconditionally and answer
  `true`.
- A login that rehashes a password, and a voluntary password change, now write by compare-and-set,
  so a concurrent reset or expiry is not overwritten. A lost change answers `invalid` and revokes
  nothing.

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
- Known issue from RFC L1-3: until `covers` and `summary` read model summaries (TODO(E1) below), a
  target whose permissions come only from scoped, bare-type or pattern-limited grants can look
  weaker than it is, and a caller without those permissions could impersonate it. Impersonation is
  the release-blocking case.

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

### N2: sessions

- Session ids have 128 bits and are stored as SHA-256. Only a lowercase UUID v4 input falls back to a
  raw lookup, so a 2.x session survives the upgrade (SR-18).
- A pending session (after the password, before MFA) lives `authn.session.pendingTtlSeconds` (300 s),
  is never extended, yields no principal and cannot be activated through `set`.
- Banning or deactivating an impersonator ends the impersonation (SR-06).
- The cookie is `Secure` and `__Host-` prefixed unless the app env is development or test
  (`hostPrefix` and `secure` default to `'auto'`). The flags follow the app env that the deployment
  resolved, not `NODE_ENV=production` alone (SR-16). The boot refuses the public cookie secret outside development and test.
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
- CLI: `authn:password <login>` (the password from `--generate` or standard input, never an argument)
  and `authn:password-expire` (the expiry job). They replace `user:password`.
- Redeeming a reset on an invite-pending identity also publishes `invite.redeem`. `users` activates
  the account on it.
- Reset calls without a client IP share one `ip: unknown` throttle bucket. Make sure `authn-http`
  passes the IP from the trusted proxy chain.
- Port `PasswordMailer` so it renders and sends at once and never queues the secret (SR-09).

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
  unless `authn.linking.jit` is on. The default provider name is `jwt:<issuer>`.
- The 2.x token API is kept under `src/legacy/`, deprecated, until R1.
- Hooks: `TokenOwnerResolver` (default `UsersTableTokenOwnerResolver`, user owners only),
  `TokenProfilePolicy` (default `NoTokenProfilesPolicy`: no profile allowed, as in 2.x) and an
  optional `RoleSource`.

> **TODO(N8b): the token routes.** The 2.x `/user/tokens` route still mints tokens with no expiry and
> without fresh auth until N8b moves it onto `TokenService` (SR-08 stays open on the HTTP path).
> Replace this block with the final route behaviour.

### N7: keys (`authn-keys`)

- Ed25519 and P-256 public keys only. The algorithm comes from the key record, never from a token. See
  the [authn README](../authn/README.md#keys).
- Challenge signing input, assertion `iss`, HTTP signature rules and the `authn.keys.*` keys are
  documented in `packages/authn-keys/README.md`.
- A registered key needs `authn.keys.assertion.audience` for `keys-jws` and `authn.keys.challenge.audience`
  (or the assertion audience) for challenges.
- Build `SignedRequest.targetUri` from the configured public origin, never from `Host`.

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
`reflection`). P4: the `__Host-ssid` rename logged tests out; tests now read the cookie name from
`SessionCookieFactory.Name`. Clients that hard-code `ssid` need the same fix. For local http set
`authn.session.cookie.hostPrefix: false` in a development config.

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
| SR-05 | Attempts are counted before verification, atomically. Nobody can lock the owner out. |
| SR-06 | An impersonation ends when the impersonator is revoked, and after `authn.impersonation.maxMinutes`. |
| SR-07 | A session between password and MFA yields no principal. |
| SR-08 | A reset revokes API tokens. Minting a token needs fresh auth. Expiry is mandatory, at most 90 days. |
| SR-09 | Reset secrets are SHA-256 at rest. TOTP secrets are AES-256-GCM at rest. |
| SR-10 | Credential admin routes need `users:credentials` and a target guard. |
| SR-11 | An audit trail (log and database) is on by default. |
| SR-12 | CSRF origin check on cookie requests. CORS with an empty list allows nothing. |
| SR-13 to SR-15 | argon2 defaults pinned and rehash on login. No trimming, one length limit. A TOTP code works once. |
| SR-16 | Cookie flags follow the app env, not `NODE_ENV=production` alone. |
| SR-17 to SR-20 | An opaque error for a missing reset. Session ids hashed. Logs carry keyed hashes of identifiers. Re-authentication counts into the throttle. |

## 11. Parts not built yet

Each block below belongs to a lane that had not merged when this guide was written. The design fixes
the behaviour where a sentence says so. The rest is for the lane report.

### L1b: ladders, rules, links

> **TODO(L1b):** the config keys and samples for `authz.rbac.ladders`, `authz.rbac.rules` (`restrict`,
> `cap`, `threshold`), implied roles, tags and share links. No 2.x equivalent exists, so only apps
> that adopt them need this.

### L2: RBAC stores, migrations, CLI

> **TODO(L2):** `ConfigRoleStore`, `DbAssignmentStore`, the migrations (`authz_assignment`, `authz_rule`,
> `authz_link`, `authz_version`), the CLI commands `authz:assign`, `authz:revoke`, `authz:explain` and
> `authz:check-config`, and how an app registers the RBAC model. The design fixes the 2.x to 3.0
> effect: `users.Role` becomes `$global` assignments, and the drop migration refuses to run on an
> incomplete copy.

### L4 and L4b: ORM adapter

> **TODO(L4):** `@AccessResource`, `@Owner`, `@ScopeColumn`, `@OrmScope`, `OrmScopePolicy`,
> `filterFields`, `ownsBy`, `DbDecisionAudit`.
>
> **TODO(L4b):** RBAC rules compiled to SQL for lists.

### L6: queue

> **TODO(L6):** `@Job({ runAs })`, `Initiator` stamping, `QueueChangeBus`, `QueueAuthzEventSink` with
> `RoleAssigned` and `RoleRevoked`. The design fixes the default: a handler runs unattended unless the
> job says `runAs: 'initiator'` or `'system'`.

### L7: authz-fs

> **TODO(L7):** `authz.fs.<name>` config, the guarded file system, the `fs` domain. The design fixes
> the default: a file system with no `authz.fs` entry, or `mode: 'off'`, is the raw provider (H9).

### K1: canvas conformance

> **TODO(K1):** no app change expected. Canvas uses the authz tables through `AuthzAdmin`.

### E1: covers and summary

> **TODO(E1):** `covers` and `summary` read model summaries (RFC L1-3). Until then see the known issue
> under L1.

### N1: authn core

> **TODO(N1):** `AuthnService`, the strategy registry, `MfaPolicy`, `ImpersonationService`, the throttle
> engine, audit fan-out, the `authn.*` boot checks and old-key detector. The design fixes the order
> of the flow: throttle, strategy, link, status, MFA, principal, session.

### N5: authn-totp

> **TODO(N5):** `TotpMfaStep`, recovery codes, the TOTP CLI and the 2FA routes. The design fixes the
> storage: encrypted secrets in `authn_mfa`, a code works once, ten recovery codes stored as SHA-256.

### N8a and N8b: authn-http

> **TODO(N8a):** the middleware order (client IP, CSRF origin guard, `AuthnMiddleware`), credential
> extractors, `Authenticated`, `FreshAuth`, `MfaSatisfied` policies, `/auth/*` routes, impersonation
> and role switch.
>
> **TODO(N8b):** `/user/tokens`, `/user/keys`, `POST /auth/keys/challenge|login`, and the credential
> admin routes under `/authn/admin/users/:uuid/*`.

### N10: OIDC

> **TODO(N10):** see [OIDC](../authn/oidc.md). Config keys as built, routes and the preset list.

### C1 to C9: users, users-http, authz-http-admin, consumers

> **TODO(C1):** the `users` identity contracts, removal of the copied 2.x code and 2.x
> `authn.local` keys, `PasswordAgeSource`, activation on `invite.redeem`, `QueueAuthnEventSink`.
>
> **TODO(C2):** `users-http` routes on `@Access`. Keep the uniform 404 on metadata (SEC1).
>
> **TODO(C3):** `AuthzImpersonationGuard`, `AccessResponseExtension` (adds `Access` to answers),
> `RbacRoleSource`.
>
> **TODO(C4):** `authz-http-admin` routes over `AuthzAdmin` (`/authz/commands` and the others).
>
> **TODO(C5 to C9):** `authz.token.*` end to end, telemetry, swagger, config, sockets and mail
> consumers.

### R1: removal of the 2.x code

> **TODO(R1):** the 2.x modules still exported for the moved packages (`authn-token/src/legacy`), the
> `rbac.*` package defaults, and the switch for `authz.config.rejectLegacyKeys`.

### X1: release

> **TODO(X1):** release notes (the high findings stay open in 2.x, tokens without expiry, the token
> CLI rename, the `__Host-ssid` rename, the Electron IPC note), and the `npm deprecate` pointers.
