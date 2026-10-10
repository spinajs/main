# Release notes — SpinaJS 3.0.0-rc.1: authentication and authorization

> 3.0 splits `@spinajs/rbac` into three families: identity (`@spinajs/users*`), authentication
> (`@spinajs/authn*`) and authorization (`@spinajs/authz*`). There is no compatibility mode, no
> re-export shim and no 2.x patch. How to move an app: `docs/authz/migration-guide.md`. Overviews:
> `docs/authz/README.md`, `docs/authn/README.md`, `docs/authn/oidc.md`. Design:
> `docs/plans/2026-10-01-authz-v3-design.md` (rule numbers such as H1, B24, A31 and SR-03 point there).

## Upgrade now: the 2.x security findings stay open

A review of the 2.x authentication code found 3 high, 9 medium and 8 low findings (SR-01 to SR-20).
There is no 2.x patch (H34). 3.0 fixes each one, with a test that replays the 2.x attack. **SR-01, SR-02
(reset tokens and TOTP secrets readable through the metadata routes) and SR-03 (no backoff behind a
proxy) stay exploitable in released 2.x until an app upgrades.** The migration guide, section 10, says
what each fix changes for an app.

## Before the first 3.0 start

1. **Back up the database.** One migration copies `users.Role` into `authz_assignment`, and the next
   drops the column (H13); the drop's `down()` rebuilds it from the assignments. The authn data migration
   carries pending resets and invites into `authn_secret`; its `down()` deletes those rows and names the
   users, who must ask for a new link.
2. **Run the converter** on the compiled config: `npx spinajs-authz-convert lib/mjs/config --out src/config
   --db rbac-facts.json` (`@spinajs/authz-convert`). It writes `authz-generated.ts`, `users-generated.ts`,
   `authn-generated.ts` and `authz-warnings.md`. Then delete every `rbac.*` key: boot fails on one.
3. **Set the secrets** from a secret store, never inline: `http.cookie.secret` (the public default
   fails boot), `authn.mfa.encryptionKey.secret` (when any user has 2FA, or the `totp` step is listed),
   `authn.audit.hashKey.secret` (32 characters or more), `authz.rbac.links.secret` (when you use share
   links), each OIDC provider's `clientSecret`, and optionally `authn.local.pepper.secret`.
4. **Name the env** (`APP_ENV`, `NODE_ENV` or `--env`) in every deployment. A missing env now counts as
   production for authn.
5. **Set `http.trustProxy`** behind a proxy, and list browser origins in `http.cors.origins` and, for
   cookie sessions on other origins, in `authn.http.csrf.allowedOrigins`.
6. **PostgreSQL:** `ALTER ROLE <role> SET jit = off` (or per database), version 12 or later.
7. **Stop every 2.x node** before the first 3.0 node starts.

## BREAKING CHANGES

### Packages

| 2.x package | 3.0 packages |
|---|---|
| `@spinajs/rbac` | `@spinajs/users`, `@spinajs/authn-local`, `@spinajs/authn-session`, `@spinajs/authz-rbac` |
| `@spinajs/rbac-http` | `@spinajs/authn-http` (and `@spinajs/authz-http`) |
| `@spinajs/rbac-http-user` | `@spinajs/authn-http`, `@spinajs/authn-totp`, `@spinajs/users-http` |
| `@spinajs/rbac-http-admin` | `@spinajs/users-http`, `@spinajs/authn-http`, `@spinajs/authz-http-admin` |
| `@spinajs/rbac-http-token` | `@spinajs/authn-token`, `@spinajs/authn-http` |
| `@spinajs/session-provider-db`, `-redis`, `-dynamodb` | same names, on the `authn-session` contract |
| `@spinajs/orm-api` | removed, no replacement (H5) |

- New: `authn` (core), `authn-orm`, `authn-keys`, `authn-oidc`, `authz`, `authz-abac`, `authz-orm`,
  `authz-http`, `authz-queue`, `authz-fs`, the test kits `authz-testing` and `authn-testing`, the
  converter `authz-convert`, and `http-socket-common`.
- The five `rbac*` names get `npm deprecate` pointers at `3.0.0` final and nothing else (H25).
- Table names and migration class names do not change (`users`, `users_metadata`, `user_sessions`,
  `rbac_access_tokens`, `RBACInitial_2022_06_28_01_13_00`).
- **Import these in the app entry**, before `Controllers` or `HttpServer` resolve; no other package
  loads them for you: `@spinajs/users` (identity store, principal factory and the authz-backed hooks;
  without it `AuthnService` fails boot), `@spinajs/authn-http` (when only the controller scan loads it,
  it comes too late and no request is authenticated), `@spinajs/authn-totp` for TOTP and the
  `/user/mfa` routes (`authn-http` no longer loads it), and `@spinajs/authz-orm`, `authz-queue`,
  `authz-fs` and `authn-oidc` when used.
- **The app wires the RBAC and ABAC models**: `registerRbac(DI.RootContainer, configuration)` from
  `@spinajs/authz-rbac`, then bind its `linkResolver` as authz-http's `LinkResolver`; for ABAC, register
  `new AbacModel()` and its `AbacContributor`. See `docs/authz/README.md`, "Wiring the models".
- Build from source: run `npm run clean` after pulling. An incremental build keeps old 2.x controllers
  and config modules in `lib/`, which the loader and the controller scan would pick up.

### Configuration

- **`rbac.*` fails boot.** No package reads or ships a `rbac.*` key. `authz.config.rejectLegacyKeys` and
  `authn.config.rejectLegacyKeys` default to `true`: the boot error names each key, its 3.0 target and
  the converter, never a value. `false` only warns.
- **The role switch key moved.** `rbac.roleSwitch.requirePassword` is not read, not even as a fallback.
  Set `authz.principals.roleSwitch.requirePassword` to the roles a switch asks the password for; unset,
  every role asks for it.
- `authz.impersonation.protectedRoles` defaults to `['admin']`. 2.x protected `system` by default, and
  the converter carries that only when your config set the key: otherwise set it yourself, or `system`
  loses its protection. `rbac.admin.roleGuard.*` is
  `authz.admin.guard.*`; `rbac.token.rolePolicy` is `authz.token.rolePolicy` (a `TokenRolePolicy`,
  synchronous); `rbac.password.blockAfterAttempts` and `lockoutTime` are gone (backoff, below).
- **Config errors.** Every package checks its keys against a JSON schema registered at import. A value
  the schema refuses fails boot with `InvalidConfiguration`, whose `violations[]` carry the full `path`,
  the `schema` and a `message`; no value is printed. Some floors that guard a value the schema never saw
  still throw `InvalidOption`.
- `authn.throttle.service` may stay unset: the core takes the only registered throttle, or the only one
  besides `MemoryAuthnThrottle` (so importing `authn-orm` selects `DbAuthnThrottle`). Two or more
  besides the memory one need the key.
- **JIT and email linking need two switches**: the global `authn.linking.jit` / `byVerifiedEmail`, and
  the strategy's own (an OIDC provider's `linking.*`, a JWT issuer's `linking.jit`). All default off.
- `authz.abac.scopeResiduals` (default `false`; `authz.<name>.scopeResiduals` for an ABAC model with
  another name) is new and opt-in. On, an ABAC comparison of `scope.<type>.*` on a list becomes a SQL
  leaf. Off, such a comparison cannot be decided on a list: a deny policy denies the list with
  `needs_subject` (B19), and a permit makes the ABAC vote indeterminate, which denies the list under
  `deny-overrides` (B39). It needs `authz-rbac` loaded for lists through authz-orm.
- `http.trustProxy` is read by `RealIp` and by authn-http's `ClientIp` (`authn.http.trustProxy` wins
  for authn): a hop count, or addresses, CIDRs and `loopback`, `linklocal`, `uniquelocal`. `true` means
  one hop, never "trust all". A trusted proxy must overwrite `X-Forwarded-For`, `-Proto` and `-Host`.
- `authn.audit` has no `sinks` key (it fails boot): every registered `AuthnEventSink` gets every event.
- `authz.queue.stampedInitiatorWarning`, `authz.orm.allowJit`, `authz.http.admin.domain`,
  `authz.fsMetadata.connection`, `telemetry.auth.permissions.*`, `telemetry.auth.domain` and
  `telemetry.auth.skipInDevelopment` are new.

### Authorization

- **Union of roles (H1).** A user with several roles gets the grants of all of them; a role switch only
  narrows (`ceiling.roles`). List users with several roles before the data migration.
- **Unattended work is denied (H2).** CLI commands, cron jobs, queue handlers, `@Task` bodies, sockets
  without a user and config polling have no principal: every check denies them, and a query on a scoped
  model throws `AccessDenied`. Wrap them in `authz().runAs(SYSTEM, reason, fn)`, or give a job
  `@Job({ runAs: 'initiator' | 'system' })`.
- **Checks.** `@Access('X:read')` replaces `@Resource` + `@Permission` and `RbacPolicy`; class and route
  `@Access` combine with AND. `authz().can`/`assert`/`check` replace `user.can*` and
  `checkUserPermission`. `GET /grants` and `/user/grants` are gone; `GET /user/access` and
  `POST /user/access/check` replace them, and login, MFA, role switch, impersonation and whoami answers
  carry `Access`.
- **ORM.** The 2.x `@OrmResource` scoping is gone: a model without `@AccessResource` (`authz-orm`) is not
  scoped at all. `@OrmPermission` policies become `@OrmScope` policies. Register `@AccessResource` models
  before the authz domain boots; a type registered later makes every check on it throw until the
  domain boots again.
- **`users.Role` is dropped.** Read roles through `RbacService.rolesOf` or `authz_assignment`.
- **`AuthzAdmin` is the only write path** for assignments, rules, links, policies and scope attributes
  (H22). Stores have no public write methods. `DbAuthzAdminBackend` runs each batch in one transaction.
- **Rules in SQL (B44).** RBAC rules compile into list queries. Boot rule 11 refuses, on types whose
  lists run in SQL, a grant pattern that is a glob SQL cannot express (more than a fixed prefix and one
  trailing `*` or `**`) and a config rule whose `resource.*` read SQL can only treat as unknown. A config
  that booted on earlier builds may fail here; the message names the rule or grant.
- **Token roles never exceed the owner's (B24, B07).** The 2.x grant-subset check is gone; a role the
  owner lacks grants nothing.
- An intersect agent's row checks narrow to its delegate's list (reason `delegate`).
- RBAC field sets: conditional grants with the same condition are one group, unioned inside and
  intersected across groups (RFC C3-1). A custom `FieldRule` gets one conditional entry per group.
- `/authz/*` admin routes: an app with `@spinajs/authz-http-admin` installed serves them
  (`POST /authz/commands`, `/authz/assignments`, `/authz/links`, `/authz/rules`, `/authz/policies`,
  `/authz/scopes/:type/:id/attributes`). They check only that the caller is signed in; `AuthzAdmin`
  checks the rest.
- `GET /authz/explain` exists only when `authz.http.explainRoute.enabled` is `true`, and never in
  production.
- 2.x `UserRoleGranted` / `UserRoleRevoked` queue events are gone. `RoleAssigned` / `RoleRevoked` go to
  `AuthzEventSink`s; only `LogAuthzEventSink` ships, so register your own sink to put them on a queue.
- Swagger shows `x-authz-permission` and `x-authz-resource` instead of `x-rbac-*`.

### Authentication

- **No lockout (H31, A06).** Accounts are never locked. Failed attempts back off per account and per IP,
  up to a cap (`authn.throttle.*`). Interactive attempts count before they are verified; per-request
  credentials (tokens, keys) count failures only, keyed by credential and IP.
- **A missing env means production (SR-16).** With no `--env`, `APP_ENV` or `NODE_ENV`, authn uses the
  strict secret checks, a `Secure` `__Host-` cookie and https-only OIDC URLs, and warns.
- **Session cookie `__Host-ssid`** outside development and test, with `Secure`. Every 2.x session is
  logged out at the upgrade; clients that hard-code `ssid` break. For local http, name the
  env (`APP_ENV=development`). The cookie is a browser-session
  cookie; timeouts are enforced on the server. Session ids are stored hashed.
- **CORS (A31, H33).** An empty or absent `http.cors.origins` sends no CORS headers (2.x reflected every
  origin with credentials). Entries must be exact origins; a path, query, user info or wildcard host
  fails boot. `*` never comes with credentials. `Forwarded` and `X-Forwarded-*` are never allowed
  request headers.
- **CSRF origin guard (A22)**, on by default: a request with an unsafe method that carries the session
  cookie needs its own or a listed `Origin` (or, without one, `Sec-Fetch-Site: same-origin`), else 403
  `E_CSRF_ORIGIN`. `Origin: null` is refused. Behind a TLS proxy set `http.trustProxy` or list the
  public origin in `authn.http.csrf.allowedOrigins`, or every cookie write gets 403. `@spinajs/http`
  now sends `Referrer-Policy: strict-origin-when-cross-origin`; an app with its own helmet must not use
  `no-referrer`.
- **Passwords (A03, A04).** argon2id at the library defaults (64 MiB, t=3, p=4), pinned by a test; no
  cost keys. 8 to 128 code points, never trimmed. A login rehashes old hashes.
- **A password change keeps API tokens (A30)**, ends the identity's other sessions and rotates the
  current one. A reset, an admin password reset and an admin expiry revoke tokens
  (`authn.local.reset.revokeTokens`).
- **Resets and invites carry over (A32).** A link mailed before the upgrade works once, until its 2.x
  expiry.
- **Tokens.** Every token has an expiry, at most `authn.token.maxTtlDays` (90); tokens without one get
  `CreatedAt + maxTtlDays` at migration. Minting needs fresh auth. A token length below 32 or an empty
  prefix fails boot. A bearer or `x-api-key` value without the token prefix is ignored, so tokens issued
  under another prefix stop working. The CLI is `authn:token-create`, `authn:token-delete`,
  `authn:token-delete-expired`.
- **MFA.** TOTP is opt-in: list `{ name: 'totp', service: 'TotpMfaStep' }` in `authn.mfa.steps`, set the
  key and import `@spinajs/authn-totp` and `@spinajs/authn-totp/db`. With the step listed, a user with 2.x
  2FA never logs in with the password alone. **A user enrolled in a factor whose step `authn.mfa.steps`
  does not list cannot log in with a password at all**: the login gets the wrong-password answer and the
  audit reason `mfa_step_not_listed` (`mfa_enrolment_mismatch` when the listed step does not see the
  enrolment), with or without `force`. So list the step before the first 3.0 start if any user has 2.x
  2FA; `authn:check-config` names each enrolled step the list lacks. The check needs the authn-orm stores
  in the process that serves logins (import `@spinajs/authn-orm` or `@spinajs/authn-totp/db`); it then
  costs one `authn_mfa` query per password login without a listed enrolment, and a failed query refuses
  the login. A login the MFA policy refuses keeps its throttle count. `rbac:user-enable-2fa` is gone (it
  printed a secret); `authn:mfa-reset <login>` replaces it. The 2.x `User2Fa*` queue events are gone; listen for `mfa.enrol` and `mfa.disable` in an
  `AuthnEventSink`.
- **Impersonation** needs the actor at `aal2` and fresh auth by default, ends when the actor is
  revoked or loses the permit (asked again on every request), and after `maxMinutes`.
- **Hooks.** The `LogoutHandler` extension point is gone: listen for `logout` in an `AuthnEventSink`.
  `ExternalLoginHook`s run before the session is issued; a throw fails the login.
- users re-emits `UserLogged`, `UserLoginFailed`, `UserPasswordChanged`, `UserPasswordExpired`,
  `UserPasswordChangeRequest`, `UserImpersonationStarted` and `UserImpersonationEnded` on the queue. A
  redeemed invite no longer emits `UserPasswordChanged`; `create()` with a password does. `LastLoginAt`
  is no longer written. users does not verify stored emails: keep `authn.linking.byVerifiedEmail` off
  with its store.
- OIDC (`authn-oidc`) is new; 2.x had none.

### HTTP routes and answers

| 2.x | 3.0 |
|---|---|
| `GET /auth/whoami` | `GET /auth` (no `Authorized`, `Grants` or role list; `Access` instead) |
| `POST /auth/2fa/verify` | `POST /auth/mfa/verify`, `POST /auth/mfa/recovery` |
| `/user/2fa`, `/user/2fa/{enable,confirm,disable,reset}` | `GET`/`POST /user/mfa`, `/user/mfa/confirm`, `/user/mfa/disable`, `/user/mfa/recovery-codes` (no combined reset: disable, then enrol) |
| login answer `TwoFactorAuthRequired` / `TwoFactorInitRequired` | `{ MfaRequired: [...] }` |
| `GET /user/refresh` | `GET /user` (users-http's `@User()` route arg is `@CurrentUser()`) |
| `GET /user/grants`, `GET /grants` | `GET /user/access` |
| `PATCH /user/password` (users-http) | `PATCH /user/password` (authn-http, `PasswordService.change`) |
| `/users/security/{changePassword,password-reset-request,expire-password,reset2fa,2fa/enable,2fa/disable,unlock}` | gone; `POST /authn/admin/users/:uuid/password-reset`, `/mfa-reset`, `DELETE .../sessions`, `DELETE .../tokens` |
| `DELETE /users/security/sessions/:uuid` | `DELETE /authn/admin/users/:uuid/sessions` |
| `GET /user/tokens/roles`, `/profiles` (rbac-http-token) | the same paths in users-http |
| `GET jobs/v1/:jobId/status` for an unknown id: 200 `queued` | 404, as for a job the caller may not read |
| — | `/user/keys`, `POST /auth/keys/challenge`, `POST /auth/keys/login`, `/auth/oidc/:provider/*` |

- **Body fields.** Login `login` (2.x `Email`) and `password` (`Password`); role switch `role`
  (`Role`); impersonation `target` (`TargetUuid`); password reset `login`, `secret` (`Token`),
  `password`, `confirmPassword`, `oldPassword`. Both spellings are accepted. Inline re-authentication
  sends `reauthPassword`.
- **Error bodies.** Every authentication failure (login, MFA, re-auth, reset redemption, key login,
  and OIDC for a client that is not a browser navigation) is 401
  `{ error: { code: 'E_AUTH_FAILED', ... } }`; a throttled login, MFA step or reset redemption adds
  `Retry-After` (a throttled re-authentication does not). An OIDC browser navigation gets a 303 to the
  failure page instead. The CSRF guard answers 403 `{ error: { code: 'E_CSRF_ORIGIN', ... } }`. authn-http policies answer
  `{ error: '<code>' }` (`unauthenticated`, `fresh_auth_required`, `mfa_required`, `session_required`,
  `impersonating`, `role_not_held`, ...). `@Access` answers 403 `{ error: 'forbidden', permission,
  resource, reason }`.
- A failed reset redemption is 401 with the login failure body (2.x: 400 `E_RESET_TOKEN_INVALID`). A
  throttled reset request is 429 `{ error: 'throttled' }` with `Retry-After`.
- Token routes: the list is a bare array of `{ Uuid, Name, Kind, Roles, Profile, Scope, CreatedAt,
  ExpiresAt, LastUsedAt, LastUsedIp, Expired }`; create needs `expiresAt` and answers
  `{ Token, Plaintext }` once; 400 `invalid_*` codes replace `E_TOKEN_ROLE_NOT_ALLOWED`; 404
  `token_not_found` replaces `E_TOKEN_NOT_FOUND`.
- Each authn-http route group answers 404 `not_found` until its service is registered (password,
  MFA, tokens, keys, credential admin); 2.x answered 403 `E_2FA_SYSTEM_DISABLED` for MFA.
- users-http: admin routes sit on `@Access('users:<action>')`; deactivate, ban and delete need fresh
  auth and the credential admin guard (`users:credentials`); a changed `Email` or `Login` needs fresh
  auth; `GET /users/roles` answers by a dry run through `AuthzAdmin`; `Role` filters but does not sort;
  `POST /users` may answer `Incomplete: { resendInvite }`; metadata lists sort by `Id`, `Key` or `Type`
  only. `AccountGuard` replaces `rbac.admin.roleGuard`. The full list: `packages/users-http/README.md`.
- Answers that carry a secret (`POST /user/tokens`, recovery codes, `POST /authz/links`, ...) send
  `Cache-Control: no-store`.

### Databases

- **PostgreSQL must run with `jit = off`** for the app's role or database (or `PGOPTIONS='-c jit=off'`).
  authz-orm refuses a connection with JIT on at domain boot or at the first scoped query;
  `authz.orm.allowJit: true` turns the check off.
- **PostgreSQL 12 or SQLite 3.35 at the least** for lists over stored rules (`WITH … AS MATERIALIZED`).
  On SQLite such lists are slow; they suit tests and small tables.
- **On PostgreSQL a list with RBAC rules works the rules out once per class of rows** (rows that share
  their scope path and rule inputs), not once per row. Each such term reads the whole model table once
  per statement, also the rows the app's own WHERE drops, so its cost grows with the table. SQLite keeps
  the per-row form. **A stored rule whose definition PostgreSQL cannot parse now fails every list of
  that model**, not only the lists that reach the rule.
- Speed (release gate 7, open while its limits are reviewed): on PostgreSQL with `jit = off`, the canvas
  file list over 1,000 files takes 90 to 182 ms (p50) and a 50-row page 90 to 128 ms. Numbers and
  method: `packages/authz-rbac/bench/RESULTS.md`.
- New tables: `authz_assignment`, `authz_rule`, `authz_rule_subject`, `authz_link`, `authz_version`,
  `authz_policy`, `authz_scope_attribute`, `authz_scope_attribute_version`, `authz_admin_idempotency`, `authz_audit` (optional),
  `fs_object` (authz-fs owners), `authn_identity`, `authn_throttle`, `authn_audit`, `authn_secret`,
  `authn_mfa`, `authn_recovery_code`, `authn_nonce`, `authn_key`. The data migration moves TOTP
  secrets, resets and invites out of `users_metadata`, widens `user_sessions.SessionId` and drops
  `users.Role`. Section 7 of the migration guide has every migration and its checks.
- MySQL and MSSQL default collations ignore case: give identity, subject, role and hash columns a binary
  collation. MSSQL cannot create the composite keys of `authz_scope_attribute` and
  `authz_admin_idempotency` yet.
- `@spinajs/orm` quotes join keys, MSSQL aliases, `ORDER BY` and `MERGE` columns and recursive CTE
  column lists with the driver's quoter.

### DI (`@spinajs/di`)

- A singleton registered in the root and first resolved through a child lives in the root, with the
  root's dependencies, and survives `child.dispose()`. A child cannot change the dependencies of such a
  singleton; register the class in the child to get its own.
- `get(Array.ofType(X))` honours `parent` and walks parents by default.
- `Array.chainOf(X)` is new: `resolve(Array.chainOf(X))` merges registrations across parent and child
  containers and also returns factory and `NewInstance` results; it may return a promise.
- **Child-container fallback.** When `unregister` empties a key, the key is dropped, so resolution falls
  back to the type itself or to the parent's entries. A child that unregistered its last entry used to
  resolve `Array.ofType(X)` to `[]`; it now gets the parent's list. `getRegisteredTypes` answers `null`
  when no container in the lineage holds the key any more.

### Validation (`@spinajs/validation`)

Why: a 400 or a log line built from a validation error must not carry what the client sent, so a
password, a token or a reset code never comes back in a response or lands in a log.

| Removed | Use instead |
|---|---|
| `new ValidationFailed(message, errors, data, schema)` | `new ValidationFailed(message, errors, schema?)` |
| `ValidationFailed.data` | nothing: the exception keeps no value of the validated data |
| `IValidationErrorDetail.value` | `details[].field` (the JSON pointer) and `details[].params` |

- The `data` argument is gone. A JavaScript caller that still passes the old order stores `data` as the
  `schema` (which is not enumerable, so it is not serialised); the fourth argument is ignored.
- `parameter` holds sanitised copies of the AJV errors: `instancePath`, `schemaPath`, `keyword`, `params`,
  `message` and `propertyName` only. AJV's verbose `data`, `schema` and `parentSchema` are dropped.
- `schema` is not enumerable: neither a spread (`{ ...err }`) nor `JSON.stringify` carries it.
  `getExpectedSchema()` and `getFieldRequirements()` still read it.
- `toString()` prints no value, and of the schema only its `$id` (`inline schema` when it has none).
- `DataValidator`: AJV runs with `verbose: true` whatever the `validation` configuration says, and no
  error leaves the validator unsanitised. `tryValidate` and `validateSchema` return sanitised errors. A
  rule written with `$data` reports `params: { $data: '<pointer>' }` and a message that names only the
  keyword and the pointer. The `discriminator` error drops `params.tagValue`.
- New: `sanitizeError(error, schema?)` reduces one AJV error the same way.
- `@spinajs/http`: query values are redacted in HTTP log lines; a body that fails the parser's `verify`
  hook answers 400, not 500; a malformed XML body answers 400 without the parser's text.

### Email (`@spinajs/email`, `@spinajs/templates`)

- `IEmail.redact` lists secret values that the model or text carries (a reset token, a link holding it).
  Such a mail is never queued: `sendDeferred` refuses it. `EmailSent` carries no `Model` or `Content`
  for it. Errors that the service, the SMTP transport, the `email.send` and `template.render` Perf spans
  log or throw have the values replaced by `[redacted]` and no `cause` (SR-09).
- `EmailPasswordMailer` sends authn-local's reset and invite mails at once and never queues the secret.
  `@spinajs/users` registers it as the `PasswordMailer` unless the app registered its own. Config
  `email.password.{connection, from, lang, reset: { subject, template }, invite: { subject, template }}`;
  `connection` falls back to `email.defaultConnection`. Without a template it sends a plain-text mail.
  Template model: `Token`, `ResetUrl`, `ExpiresInMinutes`, `IsInvite`, `Name`, `Email`, `Purpose`.
- `@spinajs/templates`: `IRenderOptions.redact` does the same for render errors.
- **Warning:** nodemailer's `logger` / `debug` options in a connection's `options` log whole message
  bodies, secrets included. Keep them off where reset or invite mails are sent.
- `EmailService.send` reads every attachment through its filesystem (`provider`, else
  `fs.defaultProvider`) before the transport, in the caller's async context: a filesystem guarded by
  authz-fs checks `fs:read` as the sending principal. An unknown filesystem fails with `IOFail`. A
  refused read rethrows the `AccessDenied` unchanged (403 over http), is logged once, counts
  `email.send.failed`, and nothing is sent.
- `IEmailAttachement.file`: the local file the service read; the transport sends it without reading
  `path` again. A `file` the caller set is ignored. `email.attachments.check` (default `true`); `false`
  leaves the reading to the transport, as in 2.x.
- `BlackHoleEmailSender` reads attachments that have no `file`, so development and tests fail where
  production would. `downloadAttachment` and `attachmentFile` are exported for other transports.
- `EmailSend` is `@Job({ runAs: 'initiator' })`: a deferred mail reads its attachments as the principal
  that queued it. A mail queued without a principal, or by a delegated or impersonating principal, runs
  unattended, so a guarded attachment is refused.
- Templates are still read by the transport. Give template filesystems, and the filesystems of
  `users.email.*.attachments`, no `authz.fs` entry: those mails often run without a user.

### Electron (`@spinajs/electron`)

- `__spinajsIpcBridge:call` and `__spinajsIpcBridge:callOnOrmConnection` run in the main process under
  `authz().runAs(SYSTEM, 'electron-ipc')`. With `authz.audit.runAs` on, each call writes one audit
  entry. Calls to the `Log` service run as they are, so renderer log lines write no audit entries.
- `__spinajsIpcBridge:callSync` answers synchronously and cannot run as `SYSTEM`: it runs unattended,
  so a scoped ORM query or an authz check inside it is denied.
- An app that never boots authz runs IPC calls as before.
- A sync call to a service that is not registered returns the error instead of throwing a `TypeError`.

### Log (`@spinajs/log`)

- Log lines written while a principal is current (in a request, under `runAs`, in a job run) carry a
  `Principal` field: the principal as `type:id`, with control characters escaped.

### Telemetry, configuration-http, queue-http-progress

- Telemetry: a slot set to `'AccessPolicy'` checks `telemetry.auth.permissions.<endpoint>` (default
  `telemetry:read`); `telemetry.auth.token` still works through a `service:telemetry` principal; the
  development bypass needs `telemetry.auth.skipInDevelopment: true` and an env that names development.
- configuration-http: its routes need `configuration:read` or `configuration:update`
  (`admin.configuration`). In an app where authz guards the config model, `configuration-db-source`
  persists and polls as `SYSTEM`, and starts only once the HTTP server listens.
- queue-http-progress: the status route needs `job:read` on the job (the initiator's own jobs, through
  `authz-queue`); without `authz-queue` imported it answers 403.

### WebSocket server (`@spinajs/http-socket` v3)

The v2 API is gone; no package in the repository used it. The full notes are in
`packages/http-socket/RELEASE_NOTES.md`; the breaking parts:

| Removed (v2) | Use instead |
|---|---|
| `WebsocketServer` | `SocketServer`, `@Injectable`, resolved after `HttpServer` |
| `SocketServerMiddleware.before` | `SocketPrincipalSource` (handshake → `Principal`, or a refusal) |
| `SocketServerMiddleware.onConnect` / `onDisconnect` | `@OnConnect()` / `@OnDisconnect()` on a socket controller |
| `SocketController` + `ISocketEvent` | `BaseSocketController` + `@SocketController(prefix)`, `@Command`, `@OnEvent` |
| `SocketMiddleware.execute` | a `SocketCommandStage`, `@SocketPolicy` or `@SocketAccess` |
| `SocketRouteArgs` | `SocketArg` + `@SocketParameter` |
| `ConnectionLogMiddleware` | the per-command debug line and the `socket_*` metrics |

- Socket controllers live in `system.dirs.socketControllers`. There is no `@User()`: use
  `@Connection() conn` and read `conn.user`.
- A connection without credentials runs as `UNATTENDED`; set `http.socket.auth.required: true` to refuse
  it. A source that yields a system or unattended principal refuses the handshake. Cookies are never a
  socket credential. The legacy rbac policies are not supported on sockets; use `@SocketAccess`.
- `http.socket.cors.origins` (default `[]`) admits cross-origin pages; an empty list refuses every
  cross-origin handshake. `Origin: null` and JSONP polling are refused.
- `SocketPrincipalSource.revalidate()` is tri-state (`'valid' | 'invalid' | 'unavailable'`); live
  connections re-check their principal every `http.socket.auth.revalidateMs` (default 60 s).
- `auth.protocol` must be `1`, `auth.clientId` 1 to 128 printable ASCII characters; names and ids are
  checked at startup and on every frame. `SocketHub` refuses `to([])`, empty room names and `sys.*`
  names.

## Notes for maintainers

- authz-queue pins `@spinajs/queue`: the queue release must ship `hooks.js`, `hook-runner.js` and
  `jobOptions`.
- authz-orm must load once per process; a second copy (another install, or its ESM and CJS builds
  together) throws when it loads.
- Release gate 7 (speed) is open while the owner reviews its limits (plan §12 item 7). The full
  numbers are in `packages/authz-rbac/bench/RESULTS.md`; the other gates are tracked in the plan.

---

# Release notes — ORM unified dirty tracking

> Branch `feat/orm-unified-dirty-tracking`. Design:
> `docs/superpowers/specs/2026-08-25-orm-unified-dirty-tracking-design.md`.

## BREAKING CHANGES

### `@spinajs/orm` — one change-tracking mechanism

`ModelBase` no longer keeps a write-time dirty list. The snapshot taken at hydration and after
every write is the only state; everything is derived from it.

| Removed | Use instead |
|---|---|
| `IsDirty` setter (`model.IsDirty = false`) | Persist the model, or `takeSnapshot()` to re-baseline by hand. |
| `markDirty(prop)` | Nothing — `attach()` / `detach()` are visible to `changeSet()` directly. |
| `changedColumns()` | `changeSet().map((c) => c.Column)` |
| The constructor's `Proxy` | Nothing — `new Model()` returns the plain instance. |

Behaviour changes:

- `IsDirty` is `true` for a model that has never been in the database (`IsNew`), and `false`
  again when a write restores the original value. It is computed on every read.
- `IsNew` and `changeSet(): IModelChange[]` (`{ Column, OldValue, NewValue }`) are new.
- Model members and column names share one namespace (active-record); a column named like a
  `ModelBase` member shadows it. The diff accessor is `changeSet()` — not `changes` — because
  `changes` is a real column name in downstream schemas.
- `insert()`, `refresh()` and `archive()` take a fresh snapshot after their statement, so a
  following `update()` on the same instance writes only what changed since. `insert()` now awaits
  its statement internally.
- `SingleRelation.attach()` on a `RelationType.Query` relation no longer flags the owner dirty;
  there is no column such a flag could write.
- `Relation.update()` persists every member that is `IsDirty` (new, or changed since loaded).
- `SingleRelation.attach(obj)` / `detach()` now also write the owner's foreign-key column (the
  target's join-column value, or `null`), and `toSql()` writes `NULL` for a detached relation.
  Before, `detach()` + `update()` — and therefore `SingleRelation.remove()` — wrote the old key
  back and never cleared the reference. A relation whose `populate()` found no row still keeps
  the row's key, as before.
- Foreign keys are resolved from the relation's **join column** (`Relation.PrimaryKey`)
  everywhere a model is serialized — `toSql()` in both `ModelToSqlConverter`s, the diff,
  `attach()`, and the unit of work's pending keys (`IPendingForeignKey` gained `JoinColumn`
  — required, a compile break for external code constructing one). Previously the target's
  primary key was used even when `@BelongsTo` declared another column. A relation holding a
  target overrides a direct write of the raw foreign-key column. Three paths remain exceptions
  and still stamp the target's **primary key**: the plain-object payload path
  (`StandardObjectToSqlConverter`); `OneToOneRelationHydrator` and `DbPropertyHydrator`, where a
  model instance passed under a relation or foreign-key name is stamped as `PrimaryKeyValue`
  (`packages/orm/src/hydrators.ts:39,120`); and `StandardModelDehydrator`'s foreign-key fallback
  (`packages/orm/src/dehydrators.ts:38`). The write path and the diff still resolve the join
  column correctly, so the rows that reach the database are right — but the in-memory and
  dehydrated value can be the primary key until the next write-back.
- `ForwardBelongsTo(ref)` without an explicit `primaryKey` now defaults the join column from the
  **target** model's primary key, resolved lazily on first access; it previously defaulted from
  the **source** model's. No in-repo caller relies on that default, so nothing here changes —
  flagged because the decorator is a published export, and an external model whose source and
  target primary keys differ will now join on a different column.
- After every successful write the foreign-key columns are reconciled with their relations
  before the fresh snapshot is taken, so a model converges to clean. Static bulk
  `Model.insert()` now re-baselines (and reconciles) model instances too.
- `SqlTimeValueConverter` (`@spinajs/orm-sql`) implements the snapshot hooks, so a `time` column
  (`TimeSpan`) baselines by value instead of `UNCOPYABLE` — previously such a column was reported
  as changed on every diff, with no usable `OldValue`, and its model never converged to clean.

---

# Release notes — email / queue / templates reliability overhaul

> Branch `feat/email-queue-templates-reliability`. These notes cover breaking changes and
> new behavior for consumers of the published `@spinajs/*` packages.

## BREAKING CHANGES

### `@spinajs/email` — connection configuration keys renamed

| Old key | New key | Notes |
|---|---|---|
| `email.connections[].pass` | `email.connections[].password` | **No fallback is provided.** A config still using `pass` will authenticate with an undefined password and fail at SMTP `verify()` on startup. |
| `email.connections[].sender` | `email.connections[].service` | `sender` was never read by the DI layer (`@AutoinjectService` always resolved the `service` key), so working configs already use `service`. The interface and JSON schema now match reality. |

### `@spinajs/email` — API renames

- `EmailService.processDefferedEmails()` → `processDeferredEmails()` (typo fix).
- Default queue routing key fixed: `EmailSendJob` → `EmailSend`. Routing is by job class
  name; the old key never matched, so deferred emails fell through to the default
  connection. If your config copied the old routing entry, rename the key.

### `@spinajs/queue` — newly registered migrations

Migrations `Queue_2026_07_02` (adds `LastError`, `MaxAttempts`, `UpdatedAt`) and
`Queue_2026_07_10` (adds `Phase`, `Message`) are now exported and therefore actually
registered/executed by the ORM. Deployments that never ran them will get the new
`queue_jobs` columns on next migration run. The `Status` column default is preserved
across the MySQL `MODIFY COLUMN` path, and rows are also inserted with an explicit
status so tracking no longer depends on a DB default.

## New behavior

### Deferred email retry, dead-letter, and failure reporting (`@spinajs/email`)

- Deferred emails (`sendDeferred`) now retry: `RetryCount` is taken from the new
  `email.retry.count` config (default **3**) or a per-email `retryCount` override.
  Previously deferred emails were marked dead on the first failure.
- New queue event **`EmailSendFailed`** is emitted exactly once when a deferred email
  permanently fails (all retries exhausted), carrying recipients, subject, JobId,
  attempt/max, and the error message. Subscribe to it to alert on failed mail.
- The default (black-hole) connection config documents a dead-letter channel
  (`defaultQueueDeadLetterChannel: 'email-jobs-dlq'`); real transports honor it.
- A failed `EmailSent` notification emit can no longer fail a successful send (which
  previously could cause a duplicate email via job retry).

### SMTP transport hardening (`@spinajs/email-smtp-transport`)

- Text-only emails (no template) now work; previously they threw `IOFail`.
- `sendMail` is guarded by an in-process resilience pipeline: 30 s timeout + 2
  exponential-backoff retries by default, configurable per connection via
  `resilience: { retries, delay, timeout }`. Note: SMTP retries are inherently
  non-idempotent — a retry after an ambiguous failure may deliver a duplicate.
- Connection verification failures are logged and rethrown as `UnexpectedServerError`
  with the original error preserved as the inner cause.

### Queue core (`@spinajs/queue`)

- `QueueService.emit()` / `QueueJob.emit()` now return the generated `JobId`
  (previously always `undefined`).
- `deduplicate` (default `true`) is implemented: a redelivered job whose `JobModel`
  row is already terminal is skipped instead of re-executed.
- `JobModel.MaxAttempts` is populated at first receipt.
- New overridable hook `QueueJob.onFailed(err, ctx)` runs after each failed execution
  (`ctx.isFinal` marks the dead-lettering failure); hook errors are logged, never mask
  the original failure.

### Metrics (Perf facade → structured logs + Prometheus)

- `template.render` / `template.compile` spans with an `engine` label
  (`@spinajs/templates`).
- `email.send` spans and `email.sent` / `email.send.failed` counters labeled by
  connection (`@spinajs/email`).

### Templates (`@spinajs/templates`, `-pug`, `-handlebars`)

- Compile caching consolidated onto one mechanism honoring
  `templates.cache.mode: 'cache' | 'revalidate' | 'always'` (dev default `always`,
  prod default `cache`).
- Renderers no longer mutate the caller's model object during rendering.
- Render timing log entries report real durations (a timer-key bug made handlebars
  always report 0 ms).
