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
| `authn-token` | `users` | Token actions and `AccessTokenRolePolicy` use `User`, `UserEvent` and role helpers. | N6 (owner resolved through links), C1 |
| `authn-totp` | `users` | 2FA actions and `Default2FaToken` read and write user metadata and emit user events. | N5 (`TotpMfaStep` on the `MfaStore` contract) |
| `authn-totp` | `http`, `queue` | `auth2Fa` throws `Unauthorized` from `@spinajs/http`; the 2FA events extend `Event` from `@spinajs/queue`. | N5 |
| `authz-http-admin` | `users` | `src/legacy/**` (`Roles`, `DefaultRoleGuard`) use `User`, `grant`, `revoke`, `AccessControl`. | C4 (deletes `src/legacy/**`), R1 |
| `authz-http-admin` | `authn-http` | `Roles` uses `AuthorizedPolicy`, `Permission`, `Resource` and the `User` route argument. | C4 (routes read the principal through `@Access` and `AuthzAdmin`), R1 |
| `users-http` | `authn-totp` | `Security` calls `enableUser2Fa`, `disableUser2Fa`, `resetUser2Fa`. | C2 (credential routes leave `Security`), N8b (credential admin) |
| `users-http` | `authz-http-admin` | `Users` and `Security` take `RoleGuard` and register `DefaultRoleGuard` by side effect. | C2, C4 (guard lives inside `AuthzAdmin`) |
| `session-provider-db`, `session-provider-redis`, `session-provider-dynamodb` | `users` | Providers extend `SessionProvider` and use `UserSession`, which still live in `users`. | N2 (types move to `authn-session`) |
| `configuration-http` | `users`, `authn-http` | Controller policies and the `admin.configuration` grants use `@spinajs/users` and `authn-http` decorators. | C6 |
| `orm-api` | `users`, `authn-http` | CRUD controllers use `AccessControl`, `User` and the `Permission` decorator. | L8 (package is deleted) |

Edges that follow §4.2 and are not listed: `authn-http` → `authn-session`,
`authn-oidc` → `authn-http`, `users-http` → `users` and `authn-http`,
`authz-http-admin` → `authz` and `authz-http`, `authz` → `authn`.
