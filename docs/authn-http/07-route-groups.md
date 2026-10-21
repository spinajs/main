# Route groups

The package mounts its routes from eleven controllers in `lib/<cjs|mjs>/v3/controllers`, which the shipped config adds to the controller scan. Most groups switch on by themselves when the service behind them is registered: install the strategy package (or `@spinajs/users`) and the routes appear; leave it out and they answer 404 as if they did not exist.

## How it works

1. The shipped config adds the controllers directory to `system.dirs.controllers`; the [controller discovery](../http/03-controller-discovery.md) of `@spinajs/http` mounts every controller in it.
2. A controller of an optional group carries a **gate policy** as its first controller-scope `@Policy`. Per request the gate checks that the group's service is registered in the container the gate resolves from. Most gates are built with `serviceRegistered(service, message)`, which returns a `ServiceGate` subclass for one service.
3. A gate that fails throws `ResourceNotFound`: **404** `{ "error": "not_found", "message": "..." }`. The controller scope is reported before the route scope, so an anonymous caller of a switched-off group also hears 404, not 401.
4. An open group answers with its routes' own policies and field checks.

| Group | Gate | Switched on by | Page |
| --- | --- | --- | --- |
| Login, logout, whoami, MFA completion | none | always on | [Login, logout and MFA routes](08-login-logout-and-mfa-routes.md) |
| Own sessions | none | always on | [Session management routes](09-session-management-routes.md) |
| Active role | `RoleSourceRegistered` | a registered `RoleSource` (`RbacRoleSource` of `@spinajs/users`) and a registered `PrincipalFactory` | [Active role routes](10-active-role-routes.md) |
| Impersonation | `ImpersonationGuardRegistered` | a registered `ImpersonationGuard` (`AuthzImpersonationGuard` of `@spinajs/users`) | [Impersonation routes](11-impersonation-routes.md) |
| Password | `PasswordServiceRegistered` | a registered `PasswordService` ([`@spinajs/authn-local`](../authn-local/README.md)) | [Password routes](12-password-routes.md) |
| MFA enrolment | `TotpEnrolmentOn` | a registered `MfaEnrolmentService` whose `enabled(steps)` is true for the steps of the configured MFA policy. For `TotpService` of [`@spinajs/authn-totp`](../authn-totp/README.md): `authn.mfa.steps` lists `TotpMfaStep` itself, not a subclass, and `authn.mfa.encryptionKey.secret` is set | [MFA enrolment routes](13-mfa-enrolment-routes.md) |
| API tokens | `TokenServiceRegistered` | a registered `TokenService` ([`@spinajs/authn-token`](../authn-token/README.md)) | [API token routes](14-api-token-routes.md) |
| Keys | `KeyRoutesOn` | a registered `KeyRegistry` ([`@spinajs/authn-keys`](../authn-keys/README.md)) and `authn.keys.challenge.audience` or `authn.keys.assertion.audience` set | [Key routes](15-key-routes.md) |
| JWKS | `JwsSignerRegistered` | a registered `JwsSigner` (`authn.keys.signer` of [`@spinajs/authn-keys`](../authn-keys/10-signing-keys.md)) | [JWKS route](20-jwks-route.md) |
| Credential admin | `CredentialAdminGuardRegistered`, plus a gate per route | a registered `CredentialAdminGuard` (`AuthzCredentialAdminGuard` of `@spinajs/users`); each route also needs its own service | [Credential admin routes](16-credential-admin-routes.md) |

## Every route

| Method | Path | Controller | Route policies | Auth needed |
| --- | --- | --- | --- | --- |
| `POST` | `/auth/login` | `AuthnLoginController` | | none |
| `POST` | `/auth/logout` | `AuthnLoginController` | | any session, pending included |
| `GET` | `/auth` | `AuthnLoginController` | | principal or pending session |
| `POST` | `/auth/mfa/verify` | `AuthnMfaController` | | pending session |
| `POST` | `/auth/mfa/recovery` | `AuthnMfaController` | | pending session |
| `GET` | `/user/sessions` | `AuthnSessionsController` | `[Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` (controller) | session principal |
| `DELETE` | `/user/sessions/:handle` | `AuthnSessionsController` | same | session principal |
| `DELETE` | `/user/sessions` | `AuthnSessionsController` | same | session principal |
| `GET` | `/auth/active-role` | `AuthnActiveRoleController` | `[Authenticated, NoTokenAuthPolicy]` | session principal |
| `POST` | `/auth/active-role` | `AuthnActiveRoleController` | `[Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` | session principal |
| `GET` | `/auth/impersonate` | `AuthnImpersonationController` | `Authenticated` | principal |
| `POST` | `/auth/impersonate` | `AuthnImpersonationController` | `[Authenticated, MfaSatisfied]` | session principal, fresh |
| `DELETE` | `/auth/impersonate` | `AuthnImpersonationController` | `Authenticated` | impersonation session |
| `GET` | `/auth/password/policy` | `AuthnPasswordController` | | none |
| `POST` | `/auth/password/reset-request` | `AuthnPasswordController` | | none |
| `POST` | `/auth/password/reset` | `AuthnPasswordController` | | none |
| `PATCH` | `/user/password` | `AuthnPasswordController` | `[Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` | session principal |
| `GET` | `/user/mfa` | `AuthnMfaEnrolmentController` | `[Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` | session principal |
| `POST` | `/user/mfa` | `AuthnMfaEnrolmentController` | the group above, or `PendingMfaEnrolment` | session principal or forced-enrolment pending session, fresh |
| `POST` | `/user/mfa/confirm` | `AuthnMfaEnrolmentController` | the group above, or `PendingMfaEnrolment` | same |
| `POST` | `/user/mfa/disable` | `AuthnMfaEnrolmentController` | `[Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` | session principal, fresh |
| `POST` | `/user/mfa/recovery-codes` | `AuthnMfaEnrolmentController` | same | session principal, fresh |
| `GET` | `/user/tokens` | `AuthnTokensController` | `[Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` | session principal |
| `POST` | `/user/tokens` | `AuthnTokensController` | same | session principal, fresh |
| `DELETE` | `/user/tokens/:uuid` | `AuthnTokensController` | same | session principal |
| `GET` | `/user/keys` | `AuthnKeysController` | `[Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` | user session principal |
| `POST` | `/user/keys` | `AuthnKeysController` | same | user session principal, fresh |
| `DELETE` | `/user/keys/:kid` | `AuthnKeysController` | same | user session principal |
| `POST` | `/auth/keys/challenge` | `AuthnKeysController` | | none for `login`; user session for `register` |
| `POST` | `/auth/keys/login` | `AuthnKeysController` | | none |
| `GET` | `/.well-known/jwks.json` | `AuthnJwksController` | | none |
| `POST` | `/authn/admin/users/:uuid/password-reset` | `AuthnCredentialAdminController` | `[PasswordServiceRegistered, Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` | admin session principal, fresh |
| `POST` | `/authn/admin/users/:uuid/mfa-reset` | `AuthnCredentialAdminController` | `[AdminMfaResetOn, Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` | same |
| `DELETE` | `/authn/admin/users/:uuid/sessions` | `AuthnCredentialAdminController` | `[SessionIssuerRegistered, Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` | same |
| `DELETE` | `/authn/admin/users/:uuid/tokens` | `AuthnCredentialAdminController` | `[TokenServiceRegistered, Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` | same |

"Session principal" means a principal from a session cookie: an API token, JWT, key or signature caller gets 403 `session_required`. "Fresh" means a login within `authn.freshAuth.maxAgeSeconds` or the account password in the body; see [Fresh authentication](05-policies.md#fresh-authentication).

The credential admin paths above mount under `authn.http.admin.basePath` (default `authn/admin/users`), and every route of the group moves with it; see [Credential admin routes](16-credential-admin-routes.md#configuration).

## Shared answers

| Status | Body | When |
| --- | --- | --- |
| 401 | `{ "error": { "code": "E_AUTH_FAILED", "message": "login or password incorrect" }, "message": "login or password incorrect" }` | Every failed authentication: login, MFA code, re-authentication password, reset secret, old password. `Retry-After` only for a throttled login (password or key), MFA code or reset redemption, never for a re-authentication. See [the shared 401 body](17-answers-and-response-extensions.md#the-shared-401-body). |
| 401 | `{ "error": "unauthenticated", "message": "..." }` | No authenticated principal, or the session ended during the request. |
| 403 | `{ "error": "<code>", "message": "..." }` | A policy or route refused an authenticated caller. Codes: `session_required`, `impersonating`, `fresh_auth_required`, `mfa_required`, `already_authenticated`, `session_exists`, `role_not_held`, `impersonation_refused`, `mfa_not_pending`, `forbidden`, `protected_role`, `escalation`. |
| 403 | `{ "error": { "code": "E_CSRF_ORIGIN", ... } }` | [CSRF origin guard](04-csrf-origin-guard.md). |
| 404 | `{ "error": "not_found", "message": "..." }` | A switched-off group or route. |
| 429 | `{ "error": "throttled", "message": "..." }` | A throttled password reset request or key login challenge; with `Retry-After`. |

Bodies of thrown errors (`unauthenticated`, policy 403s, gate 404s) also carry `stack` outside production; see [Error handling](../http/11-error-handling.md). The login failure body is built as a response and never carries `stack`.

Answers about an account, its session or its credentials carry `Cache-Control: no-store`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Route controllers | mounted by the controller scan from the shipped `system.dirs.controllers` entry | the eleven `Authn*Controller` classes | | Not exported. Switch a group through its service and add fields to the answers with `AuthnResponseExtension`. <!-- TODO(docs-hook): verify whether an app can replace or drop a single shipped controller (config arrays concatenate across files) --> |
| Group gates | resolved by class from `@Policy` | `RoleSourceRegistered`, `ImpersonationGuardRegistered`, `PasswordServiceRegistered`, `TotpEnrolmentOn`, `TokenServiceRegistered`, `KeyRoutesOn`, `CredentialAdminGuardRegistered`, `SessionIssuerRegistered`, `AdminMfaResetOn` | | Not exported; switch a group by registering or not registering its service. |
| `AuthnResponseExtension` | `Array.ofType` | none in this package | `AccessResponseExtension` of `@spinajs/users` | See [Answers and response extensions](17-answers-and-response-extensions.md). |

## Important behaviour

- Switching a group off is a registration decision, not a config flag. A group whose service is not registered answers 404 on every route.
- Gates check the registration per request, so a service registered after boot switches its group on.
- A route's own policies run in parallel with the gate. Routes that verify a password (`POST /user/tokens`, `POST /user/keys`, the admin routes) therefore do it in the handler, after the gate, never as a `FreshAuth` policy.
- Request bodies are read by their camelCase field names only (`login`, `password`, `role`, `target`, `expiresAt`, ...); each route page lists them. Any other key is ignored: a body with `Email` instead of `login` reads as a body without `login`.
- The JSDoc of each route carries `@tags` and `@security` for [`@spinajs/http-swagger`](../http-swagger/README.md).

## Related

- [Controller discovery](../http/03-controller-discovery.md): how the shipped controllers directory is scanned.
- [Policies](05-policies.md): the authentication policies the routes use.
- [`@spinajs/users-http`](../users-http/README.md): the user and account routes that sit next to these.
