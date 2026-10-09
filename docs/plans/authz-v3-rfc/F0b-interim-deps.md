# F0b interim dependencies

Package edges that exist after F0b and break the direction rules of design
§4.2 (r4, H29). Each one is a result of moving 2.x files without changing
behaviour. The lane in the last column removes it; R1 greps for any that
remain.

Source: the `dependencies` of every `package.json` under
`packages/{users,users-http,authn-*,authz-*,session-provider-*,configuration-http,orm-api}`,
checked after the F0b task 3 commit. No other edge between these packages
breaks §4.2.

| From | To | Reason | Removed by |
|---|---|---|---|
| `authn-http` | `users` | Account controllers, `services/grants.ts`, impersonation and session-cookie code use `User`, `AccessControl`, `SessionProvider` and the user actions directly. | N8a (principal handed over through `req.storage.AuthnPrincipal`), C3 (`grants.ts`, impersonation and role-list code move to `users`) |
| `authn-http` | `authn-token` | `src/token/**` (controllers, policies, middleware) use `AccessToken`, `createToken` and the token actions. | N8b (strategy routes call `TokenService` through the `@spinajs/authn` contract), N6 |
| `authn-http` | `authn-totp` | `LoginController` and the two 2FA controllers call the 2FA actions and read `TWO_FA_METATADATA_KEYS`. | N8b (`src/mfa/**` over the `MfaStep` contract), N5 |
| `authn-token` | `users` | Token actions and `AccessTokenRolePolicy` use `User`, `UserEvent` and role helpers. (G1b) The token CLI commands extend `RbacCliCommand` from `users` (master 228090a22). | N6 (owner resolved through links), C1 |
| `authn-totp` | `users` | 2FA actions and `Default2FaToken` read and write user metadata and emit user events. (G1b) `EnableUser2Fa` extends `RbacCliCommand` from `users` (master 228090a22). | N5 (`TotpMfaStep` on the `MfaStore` contract) |
| `authn-totp` | `http`, `queue` | `auth2Fa` throws `Unauthorized` from `@spinajs/http`; the 2FA events extend `Event` from `@spinajs/queue`. | N5 |
| `authn-token` | `http`, `queue` | `src/interfaces.ts` augments `@spinajs/http`'s request storage with `TokenAuth`; token actions emit `AccessToken*` events on `@spinajs/queue`. | N6 |
| `authn-http` | `queue` | `ImpersonationService` and `ImpersonationController` emit the impersonation events on `@spinajs/queue`. | N8a (events go through the authn audit and event sinks) |
| `authz-http-admin` | `users` | `src/legacy/**` (`Roles`, `DefaultRoleGuard`) use `User`, `grant`, `revoke`, `AccessControl`. | C4 (deletes `src/legacy/**`), R1 |
| `authz-http-admin` | `authn-http` | `Roles` uses `AuthorizedPolicy`, `Permission`, `Resource` and the `User` route argument. | C4 (routes read the principal through `@Access` and `AuthzAdmin`), R1 |
| `users-http` | `authn-totp` | `Security` calls `enableUser2Fa`, `disableUser2Fa`, `resetUser2Fa`. | C2 (credential routes leave `Security`), N8b (credential admin). Closed (C2b task 7): no `src` import; one test file still reads authn-totp's metadata keys, a devDependency |
| `users-http` | `authz-http-admin` | `Users` and `Security` take `RoleGuard` and register `DefaultRoleGuard` by side effect. | C2, C4 (guard lives inside `AuthzAdmin`). Closed (C2b task 7): not a dependency of users-http any more |
| `session-provider-db`, `session-provider-redis`, `session-provider-dynamodb` | `users` | Providers extend `SessionProvider` and use `UserSession`, which still live in `users`. | N2 (types move to `authn-session`) |
| `configuration-http` | `users`, `authn-http` | Controller policies and the `admin.configuration` grants use `@spinajs/users` and `authn-http` decorators. | C6 |
| `orm-api` | `users`, `authn-http` | CRUD controllers use `AccessControl`, `User` and the `Permission` decorator. | L8 (package is deleted) |

Status (R1bc, 2026-10-09): R1bc closed these edges: `authn-http` → `authn-token` as a runtime dependency (now a
devDependency for tests), `authn-http` → `queue`, `authn-token` → `users` (now a devDependency for one test file),
`authn-token` → `http` and `authn-token` → `queue`. Still open: `authn-totp` → `users`, `http` and `queue` (R1d), `users-http` → `authn-totp` is closed as a runtime edge (C2b task 7; devDependency for one test).

Status (R1d, 2026-10-09): R1d closed `authn-http` → `users` (no longer declared; `test/v3/di-name-clash.test.ts` still loads it through the workspace). `authn-http` → `authn-totp`
remains as a 3.0 edge: the MFA enrolment routes call `TotpService` directly (a type import plus a lazy
`import()`), while design §4.2 has authn-http call the strategy packages through the service contracts in
`@spinajs/authn`. That deviation is N8b's open point, left to R1 final.

Edges that follow §4.2 and are not listed: `authn-http` → `authn-session`,
`authn-oidc` → `authn-http`, `users-http` → `users` and `authn-http`,
`authz-http-admin` → `authz` and `authz-http`, `authz` → `authn`.

## Runtime note

Installing `authn-http` now brings what the 2.x `rbac-http-user` and
`rbac-http-token` packages brought: its config scans
`account/controllers` and `token/controllers` (`/auth/*`,
`/user/tokens`), it pulls in the authn-token and authn-totp configs (token
CLI, `user.tokens` grants, `rbac.twoFactorAuth.enabled: true`), and its
index registers `TokenAuthMiddleware` and `RbacHttpUserBootstrapper`. An
app that used `rbac-http` alone (for example through `configuration-http`
or `orm-api`) gets those routes too. N8a and N8b must turn each route group
on only when its service is registered (design §22.11) before 3.0 ships, and
X1 mentions it in the release notes.
