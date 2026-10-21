# Release notes — authn, authn-token, authn-http: token rotation and narrowing

> Branch `feat/ory-feat-6`. Docs: `docs/authn-token/01-token-service.md`, `docs/authn-http/14-api-token-routes.md`.

## BREAKING CHANGES

### `@spinajs/authn` — `TokenService` has two new abstract methods

`rotate` and `update` are abstract. A class that extends `TokenService` outside this repository must implement them, or
the build fails. `DbTokenService` and the new `MemoryTokenService` of `@spinajs/authn-testing` do.

### `@spinajs/authn-token` — a migration to run

`AuthnTokenRotation_2026_10_21_00_00_00` adds the nullable `PreviousToken` and `PreviousValidUntil` columns to
`rbac_access_tokens` and a unique index on `PreviousToken`. Run the ORM migrations before starting the new version.
A subclass of `TokenOwnerResolver` that overrides `tokenByHash` must now match the token whose `Token` **or**
`PreviousToken` equals the hash.

## New behavior

- `TokenService.rotate(owner, id, ctx, { graceSeconds? })` replaces the secret of a live token and keeps its id, name,
  roles, scope and expiry. The old secret stops at once, or after `graceSeconds` (0 to 604800). It evicts the validation
  cache, publishes on the `CredentialChangeBus` and audits `token.rotate`.
- `TokenService.update(owner, id, change, ctx)` renames a token, narrows its roles to a subset and shortens its expiry. It
  never widens: an added role is `invalid_scope`, a later expiry `invalid_expiry`. It audits `token.update`.
- `POST /user/tokens/:uuid/rotate` (fresh auth) and `PATCH /user/tokens/:uuid` in `@spinajs/authn-http`.
- `AuthnEventType` gains `token.rotate` and `token.update`.
- `runTokenServiceConformance` covers both methods; `MemoryTokenService` is a token service over memory for tests.

# Release notes — authn-token, authn-keys: credential cache

## New behavior

- `DbTokenService.validate` serves a successful result from memory for `authn.token.cache.ttlSeconds` (default 10;
  `0` turns it off), keyed by the token hash. A hit runs no query and no `IdentityStore.status` read; the token's
  expiry is still checked. On a miss the default `UsersTableTokenOwnerResolver` reads the token and its owner in one
  statement (new `TokenOwnerResolver.tokenByHash`). A subclass that overrides `refOf` to name owners differently must
  also override `tokenByHash`.
- `DefaultKeyRegistry.byId` serves a key from memory for `authn.keys.cache.ttlSeconds` (default 10), through the new
  `CachedKeyStore`.
- New `CredentialChangeBus` contract in `@spinajs/authn/contracts`, with the in-process default
  `InProcessCredentialChangeBus` (`@spinajs/authn/bus`). Token revocations publish `{ kind: 'token' }`,
  `revokeAllFor` publishes `{ kind: 'identity' }`, key revocations publish `{ kind: 'key' }`; the caches evict on
  every change. Other processes see a change within the ttl (decision D9).
- A status change of an owner that does not revoke its tokens (a ban through `@spinajs/users` does) takes effect
  within the token cache ttl, or at once when the code that changes it publishes `{ kind: 'identity' }`.

# Release notes — authn: no per-request writes on the token and key path

## New behavior

- `DefaultAuthnService` no longer waits for the audit sinks on a successful `token.use` or `key.use`:
  it publishes them with the new `AuthnAudit.publishDetached`. Failure events are still awaited.
  `AuthnAudit.settled()` resolves when the detached deliveries have settled; `AuthnAudit.dispose()`
  awaits it. A test that reads a sink right after a token or key success should `await audit.settled()`.
- `PeekableThrottle.peek` resolves the new `PeekVerdict`: an allowed peek carries `clean`. When no live
  throttle row holds the keys, a token or key success skips `succeed`, so a credential with no failures
  on record writes nothing to the throttle. `DbThrottleStore.peek` stays one `SELECT`. A custom
  `PeekableThrottle` must return `clean`; `false` keeps the old behaviour.
# Release notes — conditional allows are settled on the row (M1)

> Branch `feat/ory-sec-1`. Docs: `docs/authz-http/01-protecting-routes.md#conditional-allows`.

## BREAKING CHANGES

### `@spinajs/authz-http`, `@spinajs/http-socket` — a conditional allow loads the row by default

- `@Access` and `@SocketAccess` on a resource with an id now settle a conditional allow (an owner
  rule, a relation grant, an ABAC condition on `resource.*`) against the row the domain's
  `ResourceAdapter` loads. The route runs with a `TRUE` residual, or answers 403 with the reason of the
  check against the row. No adapter that can load the type, or no row: 403 `unknown_resource`.
- Before, such an allow reached the action unless the route said `subject: 'load'`. A route that did
  not apply `req.storage.AuthzDecision.residual` itself let every caller holding the conditional grant
  reach every id.
- New option `conditional: 'load' | 'action'` (default `'load'`). `'action'` restores the old
  behaviour for a route whose action applies the residual itself.
- `subject: 'load'` still works and means `conditional: 'load'`. `subject: 'none'` no longer opts out:
  use `conditional: 'action'`.
- A type-level resource (no extractor, `{ type }`) loads nothing: list routes keep their residual for
  `.accessible()`.
- How to move: give every route that relies on a conditional allow reaching its action, and applies
  the residual there, `conditional: 'action'`. A route with an id whose type no adapter can load (no
  `load()`) now answers 403 on a conditional allow; give the adapter `load()`.

### `@spinajs/authz-orm` — the runtime guard flags a primary-key load under a conditional route decision

- In the `test` env (and as a warning in `development`), `get(id)`, `where(pk, id)` and
  `findOrFail([id])` of an `@AccessResource` model inside a route whose decision is conditional (a
  type-level rule, or `conditional: 'action'`) are flagged like any unguarded select. Use
  `.accessible(permission)`, or drop `conditional: 'action'` so the route settles the decision on the
  row. Code outside a request is unchanged.

---
# Release notes — principal contracts in `@spinajs/principal`

- The new package `@spinajs/principal` holds `Principal`, `PrincipalRef`, `ResourceRef`, `Ceiling`, `AuthnFacts`,
  `IAuthnPrincipalStorage`, `SYSTEM`, `UNATTENDED`, `principalKey`, `sameRef` and `ceilingHash`. It has no dependencies.
- `@spinajs/authn/contracts` and `@spinajs/authz` re-export the same values. Existing imports keep working, and
  `SYSTEM` stays one object across all three import paths.
- `@spinajs/authz` no longer depends on `@spinajs/authn`. `@spinajs/authz-http` now lists it as an optional peer.
  `SseSessionEndSink` moved to the new subpath `@spinajs/authz-http/authn` and is no longer exported from the root
  entry. `AuthzHttpAuthnBootstrapper` loads that subpath when authn is installed.
- How to run authz without authn: `docs/authz/14-installing-without-authn.md`.

# Release notes — SpinaJS 3.0.0: authentication and authorization

> 3.0 splits `@spinajs/rbac` into three families: identity (`@spinajs/users*`), authentication
> (`@spinajs/authn*`) and authorization (`@spinajs/authz*`). There is no compatibility mode, no
> re-export shim and no 2.x patch. How to move an app: `docs/authz/migration-guide.md`. Overviews:
> `docs/authz/README.md`, `docs/authn/README.md`, `docs/authn-oidc/README.md`.

## Unreleased: queued authn mails and MJML templates

**Breaking for deployments.** Reset and invite mails of `@spinajs/authn-local` are now delivered from a queue by
default, and rendered from MJML templates.

- **Queue delivery (`authn.local.mail.delivery`, default `'queue'`).** `requestReset()`, `invite()` and `expire()`
  dispatch an `AuthnMailRequest`. With `@spinajs/users`, it becomes an `AuthnMailJob` (`@spinajs/authn-local/queue`)
  that holds only the identity, the purpose, the lifetime, the request time and the language: the job issues the
  secret and sends with `EmailService.send()` when it runs (SR-09). A retry issues a fresh secret and voids the older
  one; a job older than its lifetime is dropped. Production needs a real queue connection for `AuthnMailJob`
  (`queue.routing.AuthnMailJob`, shipped as the black-hole connection `authn-mail`) and a running consumer: outside
  development and test, building the `PasswordService` fails with `InvalidOption` when the route reaches a missing
  connection or a `BlackHoleQueueClient`. `'inline'` keeps delivering in the process, after the answer.
- **`invite()` no longer waits for the mail**, and a mailer error no longer reaches its caller.
- **No address, no secret.** A mail for an identity without an email address is not sent and issues nothing.
- **MJML templates.** `EmailPasswordMailer` always sends the template of `email.password.<purpose>.template`, which
  defaults to the built-in `authn/reset.mjml` and `authn/invite.mjml` (filesystem `email-builtin-templates`, shipped in
  `@spinajs/email` under `lib/templates`). The plain-text body is gone. A template must be an `.mjml` file, or boot
  fails; set the key to your own file to replace one mail. `@spinajs/email` now depends on `@spinajs/templates-mjml`
  and registers `MjmlRenderer`.
- **Template model.** New: `ActionUrl` (the link, `ResetUrl` stays as an alias), `AppName`
  (`email.password.appName`, default `app.name`) and `Subject`.

Docs: `docs/authn-local/13-mail-delivery.md`, `docs/email/08-password-mailer.md`.
## New: WebAuthn and passkeys (`@spinajs/authn-webauthn`)

- New package `@spinajs/authn-webauthn` on `@simplewebauthn/server`: passkey login (`PasskeyStrategy`,
  strategy `passkey`, credential kind `webauthn`), a WebAuthn second factor (`WebAuthnMfaStep`, step
  `webauthn`) and passkey management (`WebAuthnPasskeyService`). `import '@spinajs/authn-webauthn/db'`
  adds the ORM stores and the `AuthnWebauthn_2026_10_21_00_00_00` migration (tables
  `authn_webauthn_credential`, `authn_webauthn_challenge`). Configuration: `authn.webauthn.*`.
- A passkey login with user verification is `aal2`, without it `aal1`. `StrategyOutcome` gains an optional
  `assurance`, which `DefaultAuthnService` writes into the session facts (default `aal1`).
- `@spinajs/authn/contracts`: new `PasskeyService` contract; new audit event types `passkey.register` and
  `passkey.remove`.
- `@spinajs/authn-http`: `POST /auth/passkeys/challenge`, `POST /auth/passkeys/login`, `POST /user/passkeys/options`,
  `POST /user/passkeys`, `GET /user/passkeys`, `DELETE /user/passkeys/:id`, off (404) until a `PasskeyService` is
  registered and a strategy takes `webauthn` credentials.
- `@spinajs/authn-testing`: `SoftAuthenticator`, the `webauthn` port, passkey route builders and behaviour rule A33.

Docs: `docs/authn-webauthn/README.md`.

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
8. **Apply the migrations before the first start** (`spinajs migrate-up`, or `Migration.OnStartup: true`).
   The `Orm` boot now fails when a registered model's table is missing (`db.StrictTableCheck`, default
   `true`) and names each model, table and connection. Every `@spinajs/authz*`, `users*` and `authn*`
   package you import registers its models. `db.StrictTableCheck: false` restores the lenient behaviour.
   **Migrate `default` and the `authz` connection in the same run** when `db.Aliases.authz` points
   elsewhere: `spinajs migrate-up` without `--connection`, or `Migration.OnStartup` on both connections.
   The runner orders pending migrations across connections, so `AuthzRbacUserRoles_2026_10_01_00_01_00`
   (on `authz`) copies `users.Role` before `AuthzRbacDropUserRole_2026_10_01_00_02_00` (on `default`)
   drops it. Run on `default` alone, the drop fails, changing nothing, while a role is not copied.
9. **Check stored datetimes.** 3.0 writes and reads every datetime as a UTC instant: PostgreSQL sessions
   run with `TimeZone=UTC`, MySQL with `time_zone = '+00:00'`, MSSQL with `useUTC`, and new columns are
   zone-aware (ORM section below). 2.x wrote the local wall clock without an offset: SQLite text, PostgreSQL
   `timestamp`, MySQL `DATETIME`. Unless every 2.x process ran with `TZ=UTC`, 3.0 reads those rows shifted
   by the zone's offset at the time they were written. On SQLite, old `yyyy-MM-dd HH:mm:ss` rows and new
   `yyyy-MM-ddTHH:mm:ss.SSSZ` rows compare and sort wrongly as text (a session's expiry, for example) until
   the old rows are rewritten. Nothing migrates them for you: confirm that 2.x ran with `TZ=UTC`, or rewrite
   the datetime columns before the first start (shift the values to UTC; on SQLite, write them as ISO 8601
   with `Z`).

## Also in 3.0 (merged from 2.0.550 to 2.0.557)

- New `@spinajs/scheduler` and `@spinajs/scheduler-http`. The HTTP API checks `scheduler:read`, `scheduler:run`
  and `scheduler:manage` with `@Access`.
- `OrmMutex`: one atomic acquire, `ttl` and `renew()`, a per-process default tenant (`threading.mutex.tenant`
  overrides it), and expiry on the database clock. `@Task` releases its lock, renews it every `lockTtl / 3` and
  excludes overlapping runs in one process.
- Queue: a per-route `maxRetries` default for jobs without `RetryCount` (AMQP and STOMP). STOMP: configurable
  prefetch, a client id suffix (`QUEUE_INSTANCE_ID`), and ActiveMQ Classic 6 delivery fixes.
- ORM: `save()` across connections on one server, junction data on many-to-many `save()`, `clone()`, and
  `DEFAULT` for an unset column whose default is a server expression.
- PostgreSQL: `DATE` reads as UTC midnight, idle client errors no longer crash the process, column defaults are
  parsed.
- HTTP: `BufferResponse`; a policy refusal (403) wins over a missing credential (401) from another group;
  `SseStream` closes when the client left before open.

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
- `@spinajs/eslint-plugin-authz` needs ESLint 9 or 10 and a flat config: add `authz.configs.recommended`
  (a flat config object). `plugin:@spinajs/authz/recommended` and `.eslintrc` are gone.
- Table names and migration class names do not change (`users`, `users_metadata`, `user_sessions`,
  `rbac_access_tokens`, `RBACInitial_2022_06_28_01_13_00`).
- **Import these in the app entry**, before `Controllers` or `HttpServer` resolve; no other package
  loads them for you: `@spinajs/users` (identity store, principal factory and the authz-backed hooks;
  without it `AuthnService` fails boot), `@spinajs/authn-http` (when only the controller scan loads it,
  it comes too late and no request is authenticated), `@spinajs/authn-totp` for TOTP and the
  `/user/mfa` routes (`authn-http` no longer loads it), and `@spinajs/authz-orm`, `authz-queue`,
  `authz-fs` and `authn-oidc` when used.
- **The app wires the RBAC and ABAC models**: `registerRbac(DI.RootContainer, configuration)` from
  `@spinajs/authz-rbac` (it also registers the share-link `LinkResolver`); for ABAC, register
  `new AbacModel()` and its `AbacContributor`. See `docs/authz/README.md`, "Wiring the models".
- Build from source: run `npm run clean` after pulling. An incremental build keeps old 2.x controllers
  and config modules in `lib/`, which the loader and the controller scan would pick up.

### Configuration

- **`rbac.*` fails boot.** No package reads or ships a `rbac.*` key. `authz.config.rejectLegacyKeys` defaults
  to `true`: the boot error names each key, its 3.0 target and the converter, never a value. `false` only
  warns.
- authn: 2.x configuration keys are no longer detected; `authn.config` is removed.
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
  Sinks get each event concurrently, each bounded by `authn.audit.sinkTimeoutMs`, so a sink must not
  rely on the order of the others. **`authn.audit.sampleUse` fails boot**: every `token.use` and
  `key.use` success is published, none is sampled.
- `authn.impersonation.clockSkewSeconds` (0 to 300, default 30) is new: how far an impersonation's start
  may lie ahead of now or before the login. A value set at runtime past the schema that is not a finite
  number of 0 or more ends the impersonation.
- `authz.queue.stampedInitiatorWarning`, `authz.orm.allowJit`, `authz.http.admin.domain`,
  `authz.fsAcl.connection`, `authz.fsAcl.relations`, `fs.middlewareTimeoutMs`, `telemetry.auth.permissions.*`,
  `telemetry.auth.domain` and `telemetry.auth.skipInDevelopment` are new.
- **The authz tables live on the ORM connection alias `authz`.** Map it to a connection with `db.Aliases.authz`;
  it defaults to `default`. authz-fs's `fs_acl` keeps its own key, `authz.fsAcl.connection`. These keys are
  removed and fail boot with a message that names the alias to set: `authz.rbac.connection`,
  `authz.admin.connection` and `authz.<model>.connection` of an ABAC model (`authz.abac.connection`).
- `authz.rbac.maxPlanSubjects` is no longer read: a list term carries every subject. A value left set logs
  one warning.
- `db.StrictTableCheck` (default `true`) is new: the `Orm` boot fails when a registered model's table is
  missing (step 8 above).

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
- **Lists build ORM conditions, not SQL text.** A custom plan term extends `PlanTermCompiler` (authz-orm)
  and adds conditions to a where builder; `PlanTermSql`, `SqlRowContext` and `SqlFragment` (authz) are
  gone. In authz-orm, `renderPlan` is `planFilter`, `rowContext` is `planRow`, `withinSql` is
  `applyWithin`, `RelationOwnerSql` / `RelationSelfSql` are `RelationOwnerTerm` / `RelationSelfTerm`,
  and `dialectOf`, `castText`, `quoterOf`, `SqlDialect` and `storesConnection` are removed. In authz-rbac,
  `RbacAssignmentSql` / `rbacAssignmentSql` are `RbacAssignmentTerm` / `applyRbacAssignment`, and
  `sqliteDateTime` is removed.
- **Stores take no connection options.** `DbPolicyStore` and `DbScopeAttributeStore` have no constructor
  arguments (the `driver` argument and the `DbScopeAttributeStoreOptions` type are gone): they read through ORM
  models on the `authz` alias. Also removed: `policyToRow` (now `policyToRecord`, and `rowToPolicy` is
  `recordToPolicy`) from authz-abac and `parseAttributeLeaf` from authz.

### Authentication

- **No lockout (H31, A06).** Accounts are never locked. Failed attempts back off per account and per IP,
  up to a cap (`authn.throttle.*`). Interactive attempts count before they are verified; per-request
  credentials (tokens, keys) count failures only, keyed by credential and IP.
- **Memory throttle on `KeyedBackoff`.** `MemoryAuthnThrottle` keeps the same behaviour with one
  `FlowLimiter` per flow, resolved through DI; register a `FlowLimiter` subclass to replace it (keep the
  `(flow, options)` constructor, and declare `@NewInstance()` on a subclass with any DI decorator). New keys
  `authn.throttle.memory.sweepBatch` (8), `authn.throttle.memory.fullRetrySeconds` (60) and
  `authn.throttle.memory.holdOffMs` (1000); an unknown key there fails boot. `ThrottleRow` and `ThrottleTable`
  are no longer exported; for `MemoryAuthnThrottle` subclasses, the protected `tables` and `sweepBatch` give way
  to `limiter(flow)`. `MemoryAuthnThrottle` resolves `FlowLimiter` from DI on first use and throws
  `InvalidOperation` on a bad registration. `DbAuthnThrottle`: see the next item. New exports: `DEFAULT_MEMORY_THROTTLE`,
  `MemoryThrottleConfig`, and `ThrottleConfig.memory`.
  Guide: `packages/authn/src/throttle/README.md`.
- **One throttle base, two stores.** `StoreAuthnThrottle` (also at `@spinajs/authn/store-throttle`, which registers
  nothing in DI) holds the flow rules and the util `Throttle`; `MemoryAuthnThrottle` and `DbAuthnThrottle` only
  supply params, a `ThrottleStore` and key ids, and a new store (Redis, say) is a subclass. Behaviour, config keys
  and `authn_throttle` rows are unchanged. For subclasses of `DbAuthnThrottle`, the protected `claimKey`,
  `writeLive`, `insertOrTakeStale` and `undo` moved to `DbThrottleStore`; override `createStore(options)` to
  replace it (it is a documented protected seam). `@spinajs/authn-orm` now depends on `@spinajs/util` and exports
  `DbThrottleStore` and `DbThrottleStoreOptions`. Other changes for subclasses: `attempt`, `peek` and `succeed` of both
  throttles are inherited from `StoreAuthnThrottle`; `MemoryAuthnThrottle.keyId` no longer validates the value (the
  `Throttle` does, before calling it); the periodic purge in `DbAuthnThrottle.attempt` calls `DbThrottleStore.purge`,
  not the overridable `DbAuthnThrottle.purge`; `DbAuthnThrottle` rejects an unknown flow before `init()`.
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
  enrolment), with or without `force`. This login guard needs the authn-orm stores in the process that
  serves logins (import `@spinajs/authn-orm` or `@spinajs/authn-totp/db`); it then costs one
  `authn_mfa` query per password login without a listed enrolment, and a failed query refuses the
  login. A login the MFA policy refuses keeps its throttle count. List the step before the first 3.0
  start if any user has 2.x 2FA; `authn:check-config` names each enrolled step the list lacks.
  `rbac:user-enable-2fa` is gone (it printed a secret); `authn:mfa-reset <login>` replaces it. The 2.x
  `User2Fa*` queue events are gone; listen for `mfa.enrol` and `mfa.disable` in an `AuthnEventSink`.
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
- **authn needs a registered `Log` (`@spinajs/log`).** `AuthnAudit`, `DefaultAuthnService` and
  `LogAuthnAuditSink` resolve it with no console fallback; without it boot fails with the DI error.
- **A missing required neighbour fails boot with DI's generic error**, `Type X is not registered at
  container` (e.g. no `SessionIssuer`, `IdentityStore` or `PrincipalFactory`), not an authn message.
- Removed `@spinajs/authn` exports: `MfaStepRegistry` (use `steps()` of the configured `MfaPolicy`),
  `SecretStoringMfaStep` and `isSecretStoringMfaStep` (a step sets `MfaStep.storesSecrets`, RFC AT-1),
  `AuditLog`, `auditLog`, `AuthnAuditOptions`, `DEFAULT_AUDIT_SAMPLE_USE`,
  `DEFAULT_AUDIT_SINK_TIMEOUT_MS`, `MAX_AUDIT_SINK_TIMEOUT_MS`, `MIN_AUDIT_HASH_KEY_LENGTH`, the 2.x
  legacy-key exports (`AUTHN_LEGACY_KEYS`, `AuthnLegacyKey`, `AuthnLegacyKeyFinding`,
  `findAuthnLegacyKeys`, `rejectsAuthnLegacyKeys`, `authnLegacyKeysText`, `checkAuthnLegacyKeys`) and
  `LogAuthnAuditSink.out`. `authn:check-config` has no `legacy` topic. `secretStoringSteps` takes the
  map `MfaPolicy.steps()` returns instead of a container. `AuthnAudit` takes only the container;
  `LogAuthnAuditSink` takes the container in its constructor.
- **`MfaPolicy` is an `AsyncService` with an abstract `steps()`**: login, `completeMfa` and the
  enrolment routes take the steps from the configured policy. Extend `ConfiguredMfaPolicy` (as
  `DefaultMfaPolicy` does) to list `authn.mfa.steps`, once per instance at its resolve.
- **`DefaultAuthnService` resolves a `SessionIssuer` and the MFA policy at every boot**, also when only
  per-request strategies (tokens, keys) are listed: such an app must register a `SessionIssuer` too. Its
  dependencies are DI property decorators (`@Autoinject`, `@AutoinjectNamedService` with
  `MFA_POLICY_SERVICE` and `AUTHN_THROTTLE_SERVICE`, with `pickAuthnThrottle`), resolved together, so a container that registers
  its own `Configuration` must resolve it before resolving any authn service (dependencies such as `StrategyRegistry`
  read `@Config` while they resolve).
- **Services and controllers in authn*, authz* and users* take dependencies through `@Autoinject` at build**: register
  implementations before boot, a later one is not seen. A bad `authn.oidc` fails HTTP boot (`OidcController` builds
  `OidcProviders`); a CLI command whose service can't build reports `Cannot resolve command`; `StrategyRegistry`
  refuses a duplicate `authn.strategies` entry, and an unknown service is a `ServiceNotFound`.
  PrincipalSource, RoleSource, PrincipalFactory, InitiatorPrincipalFactory and PrincipalAttributeProvider implementations are
  built with their owner; resolve AuthzService per call, don't inject it.
  Instances built with `new` no longer get their dependencies (for example `UserPrincipalFactory`, `AuthzImpersonationGuard`
  without `opts.principals`, `FetchOidcHttpClient`, and `QueueChangeBus` subclasses), so build them through DI.
  A StrategyRegistry entry whose name differs from the strategy's now reports `the service has name X; the entry must match it`.
- **`SessionIssuer.revoke` and `SessionProvider.delete` resolve to a `boolean`**: true only for the call
  that ended the session, from one atomic store operation. A custom session store or issuer must return it.
  Impersonation start and stop keep their new session only when their own revoke ended the old one, so
  parallel switches on one session let exactly one through across processes, not only within one. The same
  holds for `rotate` and `elevate`: of parallel calls on one session one succeeds, the rest throw
  `InvalidOperation`, where each used to leave a live session.

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
- The admin routes can move to their own prefix, so a reverse proxy can fence them off:
  `authn.http.admin.basePath` (credential admin, default `authn/admin/users`) and
  `authz.http.admin.basePath` (authz admin, default `authz`). Both are unset by default, so no path
  changes. They rest on `@BasePath({ config, default })` in `@spinajs/http`. A controller without a
  key is moved by subclassing it with its own `@BasePath` and `DI.register(Mine).as(Theirs)`; see
  `docs/http/02-controllers-and-routing.md`.
- **Login CSRF.** `CsrfOriginGuard` also checks `POST /auth/login`, `/auth/password/reset-request`,
  `/auth/password/reset`, `/auth/keys/login`, `/auth/mfa/verify` and `/auth/mfa/recovery` without a
  session cookie (`authn.http.csrf.unauthenticatedRoutes`, matched after `http.controllers.route.prefix`).
  A browser post from another origin gets 403 `E_CSRF_ORIGIN`; a client that sends neither `Origin` nor
  `Sec-Fetch-Site` still passes. A cross-site form that logged in is the only thing that stops working.

### Databases

- **PostgreSQL must run with `jit = off`** for the app's role or database (or `PGOPTIONS='-c jit=off'`).
  authz-orm refuses a connection with JIT on at domain boot or at the first scoped query;
  `authz.orm.allowJit: true` turns the check off.
- **PostgreSQL 12 or SQLite 3.35 at the least** for lists over stored rules (`WITH … AS MATERIALIZED`).
  On SQLite such lists are slow; they suit tests and small tables.
- **On PostgreSQL a list with RBAC rules mostly works the rules out once per class of rows** (rows that
  share their scope path and rule inputs), not once per row. Each such term reads the whole model table
  once per statement, also the rows the app's own WHERE drops, so its cost grows with the table. SQLite
  keeps the per-row form, and so does PostgreSQL in a few cases (a config threshold reading
  `resource.*`, a path column without an id mode). **A stored rule whose definition PostgreSQL
  cannot parse now fails every list of that model**, not only the lists that reach the rule.
- Speed (release gate 7, open while its limits are reviewed): on PostgreSQL with `jit = off`, the canvas
  file list over 1,000 files takes 90 to 182 ms (p50) and a 50-row page 90 to 128 ms. Numbers and
  method: `packages/authz-rbac/bench/RESULTS.md`.
- New tables: `authz_assignment`, `authz_rule`, `authz_rule_subject`, `authz_link`, `authz_version`,
  `authz_policy`, `authz_scope_attribute`, `authz_scope_attribute_version`, `authz_admin_idempotency`, `authz_audit` (optional),
  `fs_acl` (authz-fs file rights and owners), `authn_identity`, `authn_throttle`, `authn_audit`, `authn_secret`,
  `authn_mfa`, `authn_recovery_code`, `authn_nonce`, `authn_key`. The data migration moves TOTP
  secrets, resets and invites out of `users_metadata`, widens `user_sessions.SessionId` and drops
  `users.Role`. Section 7 of the migration guide has every migration and its checks.
- MySQL and MSSQL default collations ignore case: give identity, subject, role and hash columns a binary
  collation. MSSQL cannot create the composite keys of `authz_scope_attribute` and
  `authz_admin_idempotency` yet.
- `fs_acl` compares `fs` and `path` byte for byte (binary collation) and keys its unique index on `path_hash`, the
  sha256 of the normalised path, so the key fits MySQL's and MSSQL's index limits with 512-character paths.
- `@spinajs/orm` quotes join keys, MSSQL aliases, `ORDER BY` and `MERGE` columns and recursive CTE
  column lists with the driver's quoter.

### ORM (`@spinajs/orm` and its drivers)

- **Datetimes are UTC instants** (step 9 above). `toJSON()` and `dehydrate()` emit ISO 8601 in UTC with
  `Z` (`2026-10-19T12:00:00.123Z`), also for numeric columns; 2.x emitted SQL text in the value's own zone.
  The created, updated, soft-delete and archive timestamps use `DateTime.utc()`, and raw
  `NOW()` or `CURRENT_TIMESTAMP` now give UTC.
- **`dateTime()` and `timestamp()` create other column types**: PostgreSQL `TIMESTAMPTZ(3)` (was
  `TIMESTAMP`), MySQL `DATETIME(3)` / `TIMESTAMP(3)`, MSSQL `DATETIMEOFFSET(3)` for both (MSSQL
  `timestamp()` is no longer `rowversion`), SQLite `TEXT` as before. Existing columns are not altered.
- **Constraint errors.** `UniqueViolation` (extends `ResourceDuplicated`, not `OrmException`) and
  `ConstraintViolation` (an `OrmException` with `kind`: `not_null`, `check`, `foreign_key` or `other`) are
  thrown by every driver. On SQLite a NOT NULL, CHECK or foreign key failure is no longer
  `ResourceDuplicated`. On PostgreSQL, MySQL and MSSQL a duplicate was an `OrmException`, so
  `catch (e) { if (e instanceof OrmException) … }` no longer catches it. MSSQL errors are wrapped: the
  driver's error is at `err.inner` (`err.inner.number`).
- **An update without a where clause throws `InvalidArgument`**, for static `Model.update(data)` and for
  update builders. Add `.where(true)` to update every row. Deletes are unchanged.
- `where(true)` and `where(false)` compile to `1 = 1` and `1 = 0` (were `TRUE` and `FALSE`).
- `count()` returns a number on PostgreSQL (was a bigint string such as `"5"`).
- **SQLite runs outermost transactions one at a time**, in call order (nested ones use savepoints). A
  statement on the writer outside the open transaction waits until it ends.
- **`@Json` writes `null` as SQL `NULL`** (was the text `'null'`). A static insert, query builder or
  `Model.update` that gives `null` to a NOT NULL `@Json` column now fails with a `ConstraintViolation`.
- Static `Model.update(data)` and `whereIn` values on a model column go through the column converters: a
  value you stringified yourself for a `@Json` column is stringified twice.
- `@Int64` is strict on write: only a bigint, a safe integer or a decimal integer string; anything else
  throws `InvalidArgument`.
- Attaching a sub-query that is already correlated with another query (`whereIn`, `whereNotIn`,
  `whereExist`, `whereNotExists`) throws `InvalidArgument`; attach a `clone()` of it.
- **Removed:** `MsSqlDatetimeValueConverter` (MSSQL registers orm-sql's `IsoDatetimeValueConverter`), and
  `toUtcColumn` / `fromUtcColumn` from `@spinajs/authn-orm` and `@spinajs/authn-keys` (authn-orm exports
  `readInstant`).
- **Strict table check at boot:** `db.StrictTableCheck` (default `true`), see step 8 above.
- **Configuration:** the search for package configs in ancestor `node_modules` directories stops at the
  workspace root (a directory with `pnpm-workspace.yaml`, or a `package.json` with `workspaces`).

### DI (`@spinajs/di`)

- A singleton registered in the root and first resolved through a child lives in the root, with the
  root's dependencies, and survives `child.dispose()`. A child cannot change the dependencies of such a
  singleton; register the class in the child to get its own.
- `get(Array.ofType(X))` honours `parent` and walks parents by default.
- `Array.chainOf(X)` is new: `resolve(Array.chainOf(X))` merges registrations across parent and child
  containers and also returns factory and `NewInstance` results; it may return a promise.
- `IToInject.resolveFunc` lets a property dependency build its own value from its `data` and the
  resolving container; a promise is awaited. `@AutoinjectNamedServices` is built on it.
- `@Autoinject(X, { check: true })` fails the resolve when no `X` is registered (as `resolve(X, true)`);
  `@Autoinject(X, { optional: true })` injects `undefined` then (as `resolveOptional(X)`). Without either,
  an unregistered class is still built from the type itself.
- **Child-container fallback.** When `unregister` empties a key, the key is dropped, so resolution falls
  back to the type itself or to the parent's entries. A child that unregistered its last entry used to
  resolve `Array.ofType(X)` to `[]`; it now gets the parent's list. `getRegisteredTypes` answers `null`
  when no container in the lineage holds the key any more.
- New: `resolveOptional(X)` resolves only a registered type and returns `undefined` otherwise;
  `getRegisteredNames(base)` lists the registration names of `base` across the lineage;
  `resolveNamed(base, name)` resolves one by name, nearest container first, and throws
  `ServiceNotFound` for an unknown name.

### Configuration and util (`@spinajs/configuration`, `@spinajs/util`)

- Configuration: `resolveNamedServices(container, path, type, options)` resolves the services a list
  at `path` names, keyed by `options.keyBy`; `@AutoinjectNamedServices(path, type, options)` injects
  that map when the instance is built.
  `resolveNamedService(container, path, type, options)` (options: `INamedServiceOptions`) and `@AutoinjectNamedService` resolve the one
  service the value at `path` names, with an optional default (a name, a class or a picker over the
  registered names) and duck check.
- Util: `isPlainObject`, `isNonEmptyString`, `deepFreeze` (in place; buffers and typed arrays stay
  mutable) and `frozenCopy` (a frozen copy of plain data and `Date`s; a `Map`, `Set` or class instance
  becomes a plain object).
- Util: `KeyedBackoff`, an in-memory per-key backoff table (capacity, eviction that never drops a delaying
  row, decay, `lower` to take attempts off a row), and `backoffDelayMs`. `@spinajs/authn/contracts` keeps its own `backoffDelayMs`.
- Util: `Throttle`, `ThrottleStore` and `ThrottleLower`: per-key backoff with the flow rules (gates, counted kinds,
  `lower` and `clear` on success) over pluggable storage, and `MemoryThrottleStore`, a store with one
  `KeyedBackoff` per flow. Also exported: `ThrottleKey`, `ThrottleGate`, `ThrottleFlowRules`, `ThrottleOptions`,
  `MemoryThrottleStoreOptions`, the `KeyedBackoff*` types and `DEFAULT_SWEEP_BATCH`. The util `ThrottleKey` is
  not the `ThrottleKey` of `@spinajs/authn/contracts` (that one has a narrower `kind`); alias one if you import both. "Writing a store" is in `packages/util/documentation/resilience.md`.

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
  `fs.defaultProvider`) before the transport, in the caller's async context: a filesystem whose
  `authz.fs.<name>.mode` is `enforce` or `audit` checks `fs:read` as the sending principal. An unknown filesystem
  fails with `IOFail`. A
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

### File systems (`@spinajs/fs`, `@spinajs/fs-s3`, `@spinajs/fs-ftp`, `@spinajs/fs-onedrive`, `@spinajs/authz-fs`)

- **Custom providers implement protected hooks.** The public methods of `fs` (`read`, `write`, `copy`, `zip`, …) are
  concrete in the base class, and its constructor throws `InvalidOperation` when a subclass overrides one (`resolvePath`,
  `tmppath`, `tmpname`, `resolve` and `dispose` stay overridable). Rename each override to its hook; hooks receive
  normalised paths. See `docs/fs/07-middlewares.md`.

  ```ts
  // 2.x
  public async read(path: string, encoding?: BufferEncoding) { /* … */ }
  // 3.0
  protected async doRead(path: string, encoding?: BufferEncoding) { /* … */ }
  ```

- **Paths are normalised on every provider** (`normalizeFsPath` from `@spinajs/fs`, against `fs.BasePath`). A path that
  climbs above the root, holds a NUL byte, is a drive or UNC path outside the base path, or has a segment holding `:`
  or ending in `.` or a space (Win32 aliases) throws `InvalidArgument` (400) before any IO, with or without
  middlewares. `fsNative` takes `BasePath` from `Options.basePath`, the working directory without one. Without a
  `basePath`, an absolute path outside the working directory maps under it on POSIX (`/etc/passwd` is
  `<cwd>/etc/passwd`) and, as a drive path, throws `InvalidArgument` on Windows.
- `upload(srcPath, …)` reads the local `srcPath` unchecked by contract: middlewares check only the destination. Never
  pass a user-controlled `srcPath`.
- `FsMiddleware` (new) runs `before` and `after` every public file method of every provider, in ascending `order`.
  Register it by class (`@Injectable(FsMiddleware)`): while a factory or an instance is registered, every file action
  throws `InvalidOperation`. Middlewares are resolved on each action, so import order against `fsService` does not
  matter. A middleware sees the targets (normalised path,
  `file` or `dir`, access, role), the other arguments as `ctx.args`, and unchecked `ctx.exists()`, `ctx.isDir()` and
  `ctx.hasEntries()` probes. Calls a provider makes inside an action skip middlewares. `fs.middlewareTimeoutMs`
  (default 30000) bounds the `after` hooks of a `writeStream`.
- `hasEntries(path)` (new) tells whether a directory holds anything; it is checked as `list`. On `fsS3` nested keys
  count.
- `upload(src, dest?, { exclusive: true })` (new) throws `ResourceDuplicated` when `dest` exists: atomic on `fsNative`
  (`COPYFILE_EXCL`) and `fsS3` (`IfNoneMatch: '*'`), an `exists()` check on `fsFTP`, forwarded by `fsTemp`. The
  options reach middlewares as `ctx.args[1]`, and every `before` runs first: authz-fs refuses an upload without
  `fs:write` with `AccessDenied` whether or not `dest` exists. `@spinajs/configuration-http` stores config files this
  way; a refused upload leaves a same-named file in place.
- `signedUrl(path, { until, disposition })` and its alias `getSignedUrl(path, until)` exist on every provider; one
  without signed URLs throws `MethodNotImplemented`.
- `fsOneDrive` (`@spinajs/fs-onedrive`) implements no operation: its hooks are stubs that throw
  `MethodNotImplemented`. On a filesystem with `authz.fs` enabled every create and `rm` is therefore refused before
  the IO, because the `isDir` probe throws.
- `zip()` without `dstFs` writes to `fs-temp` on `fsNative`, into itself on `fsTemp`, and to the provider's temp fs on
  `fsS3` and `fsFTP`. `unzip() without `dstFs` extracts into the same provider on `fsNative` and `fsTemp`, into the temp fs on `fsS3`
  and `fsFTP`.
- **authz-fs checks through `AuthzFsMiddleware`** (order 100): `fs:<access>` on every path an action touches, under
  the mode of that path's own filesystem. Per-file rights are rows of `fs_acl` (`fs`, `path`, subject, relation); a
  row on a directory covers everything under it, and `rm` of a directory drops the rows under it (on `fsS3` every key
  is a file). A relation becomes a permission only through an RBAC relation grant, eg.
  `{ permission: 'fs:write', relation: 'editor', on: [{ type: 'fs', id: 'uploads' }] }`. With `stampOwner` the first
  writer of a free path gets an `owner` row. `FsAcl` changes rows and asserts the new permission `fs:manage` on the
  file and directory refs of the path. See `docs/authz-fs/README.md`.
- `authz.fs.<name>` keys are `mode`, `domain`, `stampOwner`, `list` and `signedUrl`. `metadata`, `resolver`,
  `inherit`, `policies` and `operations` fail boot. authz-fs builds no models and creates no domains.

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

- Static analysis runs in the `analysis` job of `build.yml` after a build: `npm run lint` (one root
  `eslint.config.mjs`, typed rules, `complexity` max 15), `npm run deps` (dependency-cruiser),
  `npm run knip` (report only) and `npm run check:packages` (publint, attw). Lint and deps fail only on
  new findings; old ones are in `eslint-suppressions.json` and `.dependency-cruiser-known-violations.json`.
  Typed lint reads the built `lib/*.d.ts` of sibling packages, so build before linting locally.
- authz-queue pins `@spinajs/queue`: the queue release must ship `hooks.js`, `hook-runner.js` and
  `jobOptions`.
- authz-orm must load once per process; a second copy (another install, or its ESM and CJS builds
  together) throws when it loads.
- Release gate 7 (speed) is open while the owner reviews its limits (plan §12 item 7). The full
  numbers are in `packages/authz-rbac/bench/RESULTS.md`; the other gates are tracked in the plan.
- Release gate item 4 is a manual release step: run `AUTHZ_FS_S3=required npm test` in `packages/authz-fs` against
  localstack, so authz-fs's B28 runs on fsNative, fsTemp and fsS3 and an unreachable localstack fails instead of
  skipping the S3 suite.

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

---

# Release notes — argon2 limiter safety (`@spinajs/authn-local`)

## New behavior

- The hasher queue is bounded. `authn.local.hasher.maxQueue` (default **64**) is the number of hash and
  verify operations that may wait for a slot. Beyond it they reject with `HasherBusy` at once, and the
  local strategy answers the login with a `throttled` failure and `Retry-After: 1`.
- `authn.local.hasher.maxConcurrent` has no fixed default any more: unset, it is
  `max(1, UV_THREADPOOL_SIZE - 1)`, so 3 with the Node.js thread pool of 4 (it was 8). Apps that rely on 8
  must set it, and should raise `UV_THREADPOOL_SIZE` with it.
- A strategy may answer `{ ok: false, reason: 'throttled', retryAfterSeconds }` when it is short of
  capacity; the core passes the wait on. The argon2 cost stays pinned; the schema still refuses cost keys.

# Release notes — authn-keys uses the core NonceStore

## BREAKING CHANGES

### `@spinajs/authn-keys` — `KeyNonceStore` is gone

`JwsAssertionStrategy` and `HttpSignatureStrategy` claim each `jti` and signature nonce in the core `NonceStore` (`@spinajs/authn/contracts`), the store `@spinajs/authn-oidc` already uses. Removed from `@spinajs/authn-keys`: `KeyNonceStore`, `DbKeyNonceStore`, `MemoryKeyNonceStore` and the `AuthnNonce` model. `nonceKey` stays. The `authn_nonce` table and its model now belong to `@spinajs/authn-orm` alone.

Only `@spinajs/authn-orm` registers a `NonceStore` (`DbNonceStore`). Without one, the two strategies refuse to boot with an error that names `@spinajs/authn-orm`; there is no memory fallback.

| Before | After |
| --- | --- |
| `DbKeyNonceStore` registered by importing `@spinajs/authn-keys` | `import '@spinajs/authn-orm'` (`DbNonceStore`) |
| `DI.register(MemoryKeyNonceStore).as(KeyNonceStore)` | `DI.register(MemoryNonceStore).as(NonceStore)`, with `MemoryNonceStore` from `@spinajs/authn/nonces` |
| `@Injectable(KeyNonceStore) class X extends KeyNonceStore` | `@Injectable(NonceStore) class X extends NonceStore` |
| `@Autoinject(KeyNonceStore)` in a custom key strategy | `@Autoinject(NonceStore)` |
| `new HttpSignatureStrategy({ registry, nonces: new MemoryKeyNonceStore() })` | the same with `new MemoryNonceStore()` |

The claim semantics are the same, so existing `authn_nonce` rows stay valid. `DbNonceStore` also rejects keys over 160 characters, which `nonceKey` never produces. A replaced `NonceStore` now serves the OIDC `state` claims too.
