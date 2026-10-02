# Test ledger: @spinajs/authn-http

Every `it` of the 2.x suite of this package at `3d22b6c8f`, classified per
plan §1 rule 6 (F5). Classes: move, adapt, rewrite, drop (definitions:
`.authz-sdd/F5-task-7-brief.md`, kept in the paragraphs below).
Rewrite-class files go to `test/legacy-v2/` in their C/N lane; the T lane
replaces them and deletes the legacy file.

Since F0b this package holds 2.x `rbac-http`, the HTTP part of `rbac-http-token`
(`token-*` tests, code under `src/token/`, N8b's folder) and the account part of
`rbac-http-user` (`account-*`, two-factor, sessions, login, password reset).

Open: 3.0 home of the token roles/profiles read routes is undecided (D26); integrator decides. They answer from `authz.token.rolePolicy` (B24), which authn-http cannot load, and N8b task 3 lists only list, create and revoke.

Departure from plan T2: T2 sends the active-role and impersonation suites to `authn-http/test/v3/`, but plan §1 rule 10 and D26 bar any `users` or `authz*` dependency in an `authn*` package (C3 acceptance greps the whole `package.json`). Tests there cannot load `RbacRoleSource`, `AuthzImpersonationGuard`, `AccessResponseExtension`, `AuthzService` or `@Access`. Rows that need them name both targets in one Target cell: the users/authz part in `users/test/` (C3), the HTTP flow in `authn-http/test/v3/` (T2) with a fake `RoleSource` or `ImpersonationGuard`. One row per `it` stays. Other rows of those suites stay in `authn-http/test/v3/` and use fakes.

Token middleware adapt rows target `authn-http/test/ (src/token/)`, N8b's folder, with lane N8a (N8a tasks 3 and 4); N8a and N8b agree on the token code (F0b hand-off).

- **move**: the test's code and assertions stay as they are; only the file moves to another package because the code under test moves there.
- **adapt**: the test stays (here or in the package the code moves to) with mechanical edits that keep its intent and its expected values.
- **rewrite**: the test asserts 2.x authorization API or behaviour that 3.0 replaces, or 2.x authentication behaviour that an N lane redesigns; the owning lane moves the file to `test/legacy-v2/` and a T lane (or the N lane) writes the 3.0 replacement, the rule ids are in the Target column.
- **drop**: no 3.0 counterpart; the reason is in the Target column.

| Class | Count |
|---|---|
| move | 0 |
| adapt | 62 |
| rewrite | 119 |
| drop | 7 |
| **total** | 188 |

Not ledgered: `authn-api-contract.test.ts` (23 its) is a 3.0 contract test that F6 added; it is not a 2.x test.

## test/active-role.test.ts

Active-role routes (`GET`/`POST /auth/active-role`) of the 2.x account controllers: role list, switch, password gate. Dominant class: rewrite (active-role switching semantics, B24/D14, A26); lane C3, replacement by T2. Rows 1 and 2 are split between `users/test/` and `authn-http/test/v3/` (D26); the others use fakes.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 180 | ActiveRoleController > AC is wired through DI > controller AC contains grants from configuration | rewrite | C3 → T2 | users/test/ (C3 task 1; B24, A26): `RbacRoleSource` is wired through DI, replaces the `AccessControl` wiring; authn-http/test/v3/ (T2): the HTTP flow reads roles from a fake `RoleSource` (N8a task 8) |
| 2 | 188 | ActiveRoleController > getActiveRole > returns active role and grants resolved from DI-backed AccessControl | rewrite | C3 → T2 | users/test/ (C3 task 3; B25, B24, A26): the role switch state answers `Access` (summary) instead of `Grants`; authn-http/test/v3/ (T2): the route returns the active role and the answer of a fake `RoleSource` (N8a task 8) |
| 3 | 199 | ActiveRoleController > getActiveRole > falls back to first available role when session has no ActiveRole | rewrite | C3 → T2 | authn-http/test/v3/; no first-role fallback: without `ceiling.roles` every held role applies (B24, D14); 3.0 expectation differs |
| 4 | 210 | ActiveRoleController > switchActiveRole > switches successfully when role is in user.Role and persists via SessionProvider | rewrite | C3 → T2 | authn-http/test/v3/; role held per `RoleSource`, not `User.Role` (H13); sets `ceiling.roles`, session rotated (A26, B24, A07) |
| 5 | 228 | ActiveRoleController > switchActiveRole > regenerates the session on switch: new id issued, old id deleted, ssid cookie reset | rewrite | C3 → T2 | authn-http/test/v3/; rotation through `SessionIssuer`, new id and cookie (A07, A26) |
| 6 | 251 | ActiveRoleController > switchActiveRole > returns BadRequest when requested role is not assigned to the user | rewrite | C3 → T2 | authn-http/test/v3/; role not held by the principal is refused (A26); error code `E_ROLE_NOT_ASSIGNED` may change |
| 7 | 264 | ActiveRoleController > switchActiveRole > returns Unauthorized when role requires password but none supplied | rewrite | C3 → T2 | authn-http/test/v3/; `requirePassword` role needs fresh auth or inline re-authentication (A13, A26); 3.0 expectation differs from "password on every switch" |
| 8 | 286 | ActiveRoleController > switchActiveRole > returns Unauthorized when supplied password is invalid | rewrite | C3 → T2 | authn-http/test/v3/; failed re-authentication counts into the `reauth` throttle (A13, SR-20) |
| 9 | 306 | ActiveRoleController > switchActiveRole > switches when password is required AND correctly verified by DI-resolved PasswordProvider | rewrite | C3 → T2 | authn-http/test/v3/; verified through the throttled fresh-auth path, not `PasswordProvider.verify` (A13, A26) |
| 10 | 327 | ActiveRoleController > switchActiveRole > does not call PasswordProvider when switching to a role NOT listed in requirePassword | rewrite | C3 → T2 | authn-http/test/v3/; no re-authentication for a role without `requirePassword` (A26) |

## test/descriptor-inheritance.test.ts

2.x `@Resource`/`@Permission` controller descriptor inheritance. Dominant class: rewrite; plan T2 sends it to `authz-http/test/ported`.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 173 | rbac controller descriptor inheritance > leaves the package controller descriptor untouched | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 2 | 182 | rbac controller descriptor inheritance > gives the subclass a descriptor object of its own | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 3 | 188 | rbac controller descriptor inheritance > inherits Resource when the subclass declares none | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 4 | 192 | rbac controller descriptor inheritance > replaces the inherited Permission instead of concatenating it | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 5 | 198 | rbac controller descriptor inheritance > inherits Permission when the subclass declares none | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 6 | 202 | rbac controller descriptor inheritance > inherits Permission when the subclass declares a Resource but no permission | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 7 | 213 | rbac controller descriptor inheritance > falls back to the default permission with nothing to inherit | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4); the "default permission with nothing to inherit" fallback must be re-decided in L5 (B01, B23) |
| 8 | 222 | rbac controller descriptor inheritance > does not refill a permission list the class emptied on purpose | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 9 | 229 | rbac controller descriptor inheritance > inherits a deliberately empty permission list | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 10 | 241 | rbac controller descriptor inheritance > resolves reads to the parent for a subclass with no rbac decorators | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 11 | 258 | rbac controller descriptor inheritance > lets a subclass name the resource its base left undeclared | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 12 | 270 | rbac controller descriptor inheritance > does not accumulate down a three level chain | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 13 | 282 | rbac controller descriptor inheritance > inherits through setRbacMetadata as well | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4); `setRbacMetadata` is 2.x API, the replacement uses the 3.0 setter |
| 14 | 294 | rbac controller descriptor inheritance > replaces an inherited route entry the subclass redeclares | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 15 | 298 | rbac controller descriptor inheritance > inherits routes the subclass does not redeclare | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |
| 16 | 306 | rbac controller descriptor inheritance > keeps resolving the descriptor from a controller instance | rewrite | N8a → T2 | authz-http/test/ported/; descriptor metadata of `@Access` on `ACCESS_DESCRIPTOR` (B23, L5 task 4) |

## test/impersonation.test.ts

2.x `ImpersonationController` start, stop and state. Dominant class: rewrite (the 2.x impersonation rule is replaced by B26 and A20); lane C3, replacement by T2. Rows 4, 7 and 8 are split between `users/test/` (B26 guard cases) and `authn-http/test/v3/` (D26); the others use fakes.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 236 | ImpersonationController > start > happy path: admin impersonates user with correct password | rewrite | C3 → T2 | authn-http/test/v3/; A20, B26, A13, A07; session keys `Impersonator` and `OriginalActiveRole` become `authn.impersonator` and the session handle; start event audited (A21) |
| 2 | 288 | ImpersonationController > start > 409 Conflict when an impersonation is already active | rewrite | C3 → T2 | authn-http/test/v3/; a second impersonation while one is active (A20) |
| 3 | 299 | ImpersonationController > start > 400 BadRequest when impersonating self | rewrite | C3 → T2 | authn-http/test/v3/; self-impersonation refused, equal sets fail the B26 strict subset (B26, A20) |
| 4 | 309 | ImpersonationController > start > 403 Forbidden when caller lacks user:impersonate createAny | rewrite | C3 → T2 | users/test/ (C3 task 2; B26): `user:impersonate` held through the authz summary, `AuthzImpersonationGuard`; authn-http/test/v3/ (T2): the 403 path with a fake `ImpersonationGuard` |
| 5 | 319 | ImpersonationController > start > 404 NotFound when loadTarget returns undefined | rewrite | C3 → T2 | authn-http/test/v3/; unknown target (A20, B26) |
| 6 | 330 | ImpersonationController > start > 404 NotFound when target is banned | rewrite | C3 → T2 | authn-http/test/v3/; banned target is refused (A20, B26) |
| 7 | 341 | ImpersonationController > start > 403 E_TARGET_PROTECTED when target has a protected role | rewrite | C3 → T2 | users/test/ (C3 task 2; B26): protected role refused by the guard; authn-http/test/v3/ (T2): the 403 `E_TARGET_PROTECTED` path with a fake `ImpersonationGuard` |
| 8 | 353 | ImpersonationController > start > 403 E_PRIVILEGE_ESCALATION when target has grants admin lacks | rewrite | C3 → T2 | users/test/ (C3 task 2; B26, H18): target combined GLOBAL permissions must be a strict subset, equal refused, ABAC included; authn-http/test/v3/ (T2): the 403 `E_PRIVILEGE_ESCALATION` path with a fake `ImpersonationGuard` |
| 9 | 365 | ImpersonationController > start > 401 E_PASSWORD_REQUIRED when requirePassword=true and no password supplied | rewrite | C3 → T2 | authn-http/test/v3/; fresh auth and an MFA-satisfied session required (A20, A13); 3.0 expectation differs from a password in the body |
| 10 | 377 | ImpersonationController > start > 401 E_PASSWORD_INVALID when password is wrong | rewrite | C3 → T2 | authn-http/test/v3/; failed re-authentication counts into the `reauth` throttle (A13, SR-20) |
| 11 | 390 | ImpersonationController > start > skips password verification when requirePassword=false | rewrite | C3 → T2 | authn-http/test/v3/; A20 always needs fresh auth, so `authn.impersonation.requirePassword=false` can only skip the inline password; 3.0 expectation differs |
| 12 | 405 | ImpersonationController > stop > restores original session and emits UserImpersonationEnded | rewrite | C3 → T2 | authn-http/test/v3/; stop restores the impersonator, rotates the session, audits the end (A20, A07, A21) |
| 13 | 442 | ImpersonationController > stop > returns 400 when no impersonation is active | rewrite | C3 → T2 | authn-http/test/v3/; stop without an active impersonation (A20) |
| 14 | 449 | ImpersonationController > stop > returns 400 E_IMPERSONATOR_GONE and cleans state when original cannot be loaded | rewrite | C3 → T2 | authn-http/test/v3/; `SR-06 banning the impersonator ends the impersonation`, A20 |
| 15 | 470 | ImpersonationController > getState > returns Active=false when no impersonation | rewrite | C3 → T2 | authn-http/test/v3/; impersonation state route, inactive (A20) |
| 16 | 475 | ImpersonationController > getState > returns full impersonation state when active | rewrite | C3 → T2 | authn-http/test/v3/; impersonation state route, active, `authn.impersonator` fact (A20, A23) |

## test/login-controller.test.ts

Login with forced 2FA enrolment while the system switch is off (lockout regression). Class: rewrite; lane N8a.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 94 | LoginController (database backed) — forceUser vs. system-wide switch > does not answer TwoFactorInitRequired when the system-wide switch is off, even with forceUser on | rewrite | N8a → N8a | authn-http/test/v3/; forced enrolment must have a route out: `rbac.twoFactorAuth.forceUser` becomes `authn.mfa.policy.force`, the pending session may call enrol and confirm (A09, A10, §22.5) |

## test/logout-handlers.test.ts

Logout handler chain (impersonation handler, default handler, DI ordering). Dominant class: adapt; the two impersonation-state rows are rewrite; lane N8a.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 140 | Logout handler chain > ImpersonationLogoutHandler > Priority is 10 (runs early) | adapt | N8a | authn-http/test/; the handler chain stays in authn-http (design §4.1.1) |
| 2 | 145 | Logout handler chain > ImpersonationLogoutHandler > returns null when session is null (defers) | adapt | N8a | authn-http/test/ |
| 3 | 151 | Logout handler chain > ImpersonationLogoutHandler > returns null when no impersonation in session (defers) | adapt | N8a | authn-http/test/ |
| 4 | 157 | Logout handler chain > ImpersonationLogoutHandler > reverts impersonation, saves session, emits event when active | rewrite | N8a → N8a | authn-http/test/v3/; logout of an impersonated session returns to the impersonator, rotates the id, audits the end (A20, A07, A21) |
| 5 | 206 | Logout handler chain > ImpersonationLogoutHandler > defers to the default handler when the impersonator account is gone | rewrite | N8a → N8a | authn-http/test/v3/; impersonator account gone or revoked ends the impersonation and logs out (A20, SR-06) |
| 6 | 244 | Logout handler chain > DefaultLogoutHandler > Priority is 999 (runs last) | adapt | N8a | authn-http/test/ |
| 7 | 249 | Logout handler chain > DefaultLogoutHandler > deletes session and returns clear-cookie payload | adapt | N8a | authn-http/test/; logout deletes the session and clears the cookie (A08); cookie name follows A07 (`__Host-` outside dev and test) |
| 8 | 263 | Logout handler chain > DefaultLogoutHandler > returns a result even with empty Ssid (no delete called) | adapt | N8a | authn-http/test/ |
| 9 | 273 | Logout handler chain > DI chain — Array.ofType(LogoutHandler) > resolves both built-in handlers via DI | adapt | N8a | authn-http/test/ |
| 10 | 279 | Logout handler chain > DI chain — Array.ofType(LogoutHandler) > sorts by Priority ascending — impersonation before default | adapt | N8a | authn-http/test/ |
| 11 | 286 | Logout handler chain > DI chain — Array.ofType(LogoutHandler) > first non-null result short-circuits the chain | adapt | N8a | authn-http/test/ |
| 12 | 312 | Logout handler chain > DI chain — Array.ofType(LogoutHandler) > null returns are skipped — next handler runs | adapt | N8a | authn-http/test/ |

## test/password-reset.test.ts

Password policy, reset request and reset redemption routes. Dominant class: adapt; lane N8b.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 46 | PasswordResetController > passwordPolicy > answers exactly what the validation provider describes | adapt | N8b | authn-http/test/ (`src/password/`); policy route over the `authn-local` policy description |
| 2 | 60 | PasswordResetController > passwordPolicy > answers an empty policy for a provider that cannot describe its rule | adapt | N8b | authn-http/test/ (`src/password/`) |
| 3 | 72 | PasswordResetController > requestReset > issues a token for a known address | adapt | N8b | authn-http/test/ (`src/password/`); stubs move from controller internals to `PasswordService` (A11) |
| 4 | 80 | PasswordResetController > requestReset > answers an unknown address exactly as it answers a known one | adapt | N8b | authn-http/test/ (`src/password/`); same body and status for a known and an unknown address (A11, SR-04) |
| 5 | 91 | PasswordResetController > requestReset > does not surface infrastructure failures to the caller either | adapt | N8b | authn-http/test/ (`src/password/`); the immediate answer hides failures of the work (A11, SR-04) |
| 6 | 110 | PasswordResetController > confirmReset > redeems the token and sets the new password | adapt | N8b | authn-http/test/ (`src/password/`); `POST /auth/password/reset` (A11) |
| 7 | 117 | PasswordResetController > confirmReset > rejects a mismatched confirmation before touching the token | adapt | N8b | authn-http/test/ (`src/password/`) |
| 8 | 122 | PasswordResetController > confirmReset > returns one opaque error for an expired token | rewrite | N8b → N8b | authn-http/test/v3/; a redeemed or expired secret fails with the A02-style opaque answer (A11, A02); the 2.x `E_RESET_TOKEN_INVALID` 400 may become 401 `E_AUTH_FAILED` |
| 9 | 131 | PasswordResetController > confirmReset > returns the same opaque error for a wrong token and an unknown account | rewrite | N8b → N8b | authn-http/test/v3/; wrong secret and unknown account stay indistinguishable (A11, A02); answer shape per A11 |
| 10 | 142 | PasswordResetController > confirmReset > rethrows unexpected failures instead of masking them as a bad token | adapt | N8b | authn-http/test/ (`src/password/`) |

## test/rbac-middleware.test.ts

Sliding session renewal in the 2.x `RbacMiddleware`. Class: rewrite per plan T2; lane N8a (target contradicts T2, see report).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 64 | RbacMiddleware sliding renewal > calls touch on an authenticated request | rewrite | N8a → T2 | authn-http/test/v3/; session restore and touch in `AuthnMiddleware` (A08); plan T2 names `authz-http/test/ported` but no authz code is involved |
| 2 | 73 | RbacMiddleware sliding renewal > refreshes the ssid cookie when touch reports the expiry changed (sliding mode) | rewrite | N8a → T2 | authn-http/test/v3/; sliding renewal of the signed cookie (A07, A08, A24) |
| 3 | 91 | RbacMiddleware sliding renewal > marks an authenticated response as uncacheable | rewrite | N8a → T2 | authn-http/test/v3/; `Cache-Control: no-store` on an authenticated response (A08) |
| 4 | 101 | RbacMiddleware sliding renewal > leaves an anonymous response cacheable | rewrite | N8a → T2 | authn-http/test/v3/; anonymous response stays cacheable (A08) |
| 5 | 110 | RbacMiddleware sliding renewal > does NOT refresh the cookie when touch reports no change (absolute mode) | rewrite | N8a → T2 | authn-http/test/v3/; absolute mode sets no cookie (A08) |
| 6 | 130 | RbacMiddleware sliding renewal > issues a renewal cookie that survives cookie-parser and still restores the session | rewrite | N8a → T2 | authn-http/test/v3/; renewal cookie survives cookie-parser (A07) |

## test/rbac-policy-unknown-role.test.ts

`RbacPolicy` handling of roles missing from the grants. Class: rewrite; plan T2 sends it to `authz-http/test/ported`.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 37 | RbacPolicy - unknown role handling > checkRoutePermission does not throw for an unknown role and reports not granted | rewrite | N8a → T2 | authz-http/test/ported/; an unknown role never throws and never grants (B12; B02 is the opposite case, an unregistered permission throws) |
| 2 | 46 | RbacPolicy - unknown role handling > checkUserPermission does not throw for an unknown role and reports not granted | rewrite | N8a → T2 | authz-http/test/ported/; same for a user record (B12) |
| 3 | 55 | RbacPolicy - unknown role handling > checkRbacPermission does not throw for an unknown role and reports not granted | rewrite | N8a → T2 | authz-http/test/ported/; same for a role list (B12) |
| 4 | 62 | RbacPolicy - unknown role handling > RbacPolicy.execute rejects with Forbidden, not a raw AccessControlError, for a request carrying an unknown role | rewrite | N8a → T2 | authz-http/test/ported/; `AccessPolicy` answers 403, never a raw library error (B23, B12) |

## test/session-context.test.ts

`SessionContextProvider` response schema contributions. Class: rewrite; plan T2 sends it to `authn-http/test/v3`.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 22 | SessionContextProvider schemas > contributes nothing while no provider is registered | rewrite | N8a → T2 | authn-http/test/v3/; `SessionContextProvider` becomes an `AuthnResponseExtension`; the `Grants` key is replaced by `Access` (B25, design §22) |
| 2 | 28 | SessionContextProvider schemas > publishes the properties of a provider registered after the schemas | rewrite | N8a → T2 | authn-http/test/v3/; response schemas include extension properties registered late (B25) |

## test/sessions-controller.test.ts

Sessions list and revoke routes. Dominant class: adapt; lane N8a.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 62 | SessionsController > list > never returns a session id — only its opaque handle | adapt | N8a | authn-http/test/; list over `SessionIssuer.list`, ids hashed at rest (A07, A08) |
| 2 | 72 | SessionsController > list > flags the session making the request | adapt | N8a | authn-http/test/ |
| 3 | 82 | SessionsController > list > lists newest first and reports creation / expiry | adapt | N8a | authn-http/test/ |
| 4 | 90 | SessionsController > list > only ever looks at the calling user own sessions | adapt | N8a | authn-http/test/; own sessions only (A08) |
| 5 | 98 | SessionsController > revoke > ends the session behind a handle | adapt | N8a | authn-http/test/; revoke through `SessionIssuer.revoke` |
| 6 | 105 | SessionsController > revoke > 404s on a handle that is not one of the user own sessions | adapt | N8a | authn-http/test/; IDOR guard: a foreign handle is a 404 (A08) |
| 7 | 116 | SessionsController > revokeOthers > ends every session except the current one | adapt | N8a | authn-http/test/ |
| 8 | 124 | SessionsController > revokeOthers > ends all of them when the caller presents no session id | adapt | N8a | authn-http/test/ |

## test/token-controller-roles.test.ts

`/user/tokens/roles` and `/profiles` routes and role-policy driven create. Class: rewrite per plan T3 (token ceiling, B24); lane C5, replacement by T3. Open: 3.0 home of the token roles/profiles read routes is undecided (D26); integrator decides.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 110 | AccessTokenController - scopes route > answers with the roles the policy allows the caller | rewrite | C5 → T3 | authz-rbac/test/ported/; `authz.token.rolePolicy` decides what the caller may mint (B24) |
| 2 | 121 | AccessTokenController - scopes route > refuses a token-authenticated caller | rewrite | C5 → T3 | authn-http/test/v3/; token caller refused (`NoTokenAuthPolicy` kept; A13, A14); route home undecided (D26) |
| 3 | 131 | AccessTokenController - scopes route > refuses an impersonated session | rewrite | C5 → T3 | authn-http/test/v3/; impersonated session refused (`NoImpersonationPolicy` kept; A20); route home undecided (D26) |
| 4 | 142 | AccessTokenController - scopes route > answers the profiles route with the policy answer - none for the shipped default | rewrite | C5 → T3 | authz-rbac/test/ported/; profiles route answers the policy (B24, `attributes.profile`) |
| 5 | 155 | AccessTokenController - scopes route > refuses an anonymous caller on the profiles route | rewrite | C5 → T3 | authn-http/test/v3/; anonymous refused on the profiles route (B10, B23); route home undecided (D26) |
| 6 | 163 | AccessTokenController - scopes route > refuses a token-authenticated caller on the profiles route | rewrite | C5 → T3 | authn-http/test/v3/; token caller refused on the profiles route (A14); route home undecided (D26) |
| 7 | 174 | AccessTokenController - scopes route > refuses an impersonated session on the profiles route | rewrite | C5 → T3 | authn-http/test/v3/; impersonated session refused on the profiles route (A20); route home undecided (D26) |
| 8 | 197 | AccessTokenController - scopes route > with a policy that diverges from the caller own roles > reports the policy answer, not the callers own roles | rewrite | C5 → T3 | authz-rbac/test/ported/; policy answer, not the caller roles (B24) |
| 9 | 215 | AccessTokenController - scopes route > with a policy that diverges from the caller own roles > accepts POST user/tokens with a role this route just reported, even though the caller does not hold it | rewrite | C5 → T3 | authz-rbac/test/ported/; token roles ∩ owner roles ∩ role policy at use time (B24, B07); the creation check may differ from 2.x. OPEN: B24/B07 (never above the owner) vs design §18.3(g) (role allowed when the owner's grants cover it); C5 or the integrator decides before T3 ports these rows. |
| 10 | 264 | AccessTokenController - scopes route > profiles > GET user/tokens/profiles answers what the policy offers the caller | rewrite | C5 → T3 | authz-rbac/test/ported/; profiles offered by the policy (B24) |
| 11 | 274 | AccessTokenController - scopes route > profiles > narrows GET user/tokens/roles to the profile named in the query | rewrite | C5 → T3 | authz-rbac/test/ported/; roles narrowed to a profile (B24) |
| 12 | 290 | AccessTokenController - scopes route > profiles > POST user/tokens pins the token to the requested profile, on the wire and in the row | rewrite | C5 → T3 | authn-http/test/v3/; profile pinned on the token, source of `attributes.profile` (B24, design §14); route home undecided (D26) |
| 13 | 311 | AccessTokenController - scopes route > profiles > POST user/tokens refuses a profile the policy does not offer | rewrite | C5 → T3 | authn-http/test/v3/; a profile the policy does not offer is refused (B24); route home undecided (D26) |
| 14 | 326 | AccessTokenController - scopes route > profiles > POST user/tokens validates roles against the profile, not the owner union | rewrite | C5 → T3 | authz-rbac/test/ported/; roles validated against the profile, not the owner union (B24) |
| 15 | 345 | AccessTokenController - scopes route > profiles > accepts a create built from what the two routes just reported | rewrite | C5 → T3 | authn-http/test/v3/; create accepts what the routes reported (B24); create now needs fresh auth and an expiry (A13, A14); route home undecided (D26) |
| 16 | 361 | AccessTokenController - scopes route > profiles > refuses an empty Profile at the DTO, rather than silently minting an unpinned token | rewrite | C5 → T3 | authn-http/test/v3/; DTO validation (A14); route home undecided (D26) |

## test/token-controller.test.ts

Token self-service routes (`/user/tokens`). Dominant class: rewrite per plan T3; a few rows adapt, two drop; lane C5.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 91 | AccessTokenController > rejects anonymous access | adapt | C5 | authn-http/test/ (`src/token/`); anonymous refused (B10, B23) |
| 2 | 96 | AccessTokenController > creates a token and returns plaintext exactly once | rewrite | C5 → T3 | authn-http/test/v3/; plaintext shown once, wire shape kept; create needs an expiry and fresh auth, the 2.x test posts none (A14, A13, `SR-08 token without expiry refused`); the stranger-token-not-listed IDOR check goes to the T3 IDOR suite, as row 5 does |
| 3 | 135 | AccessTokenController > returns ExpiresAt as an ISO instant too | adapt | C5 | authn-http/test/ (`src/token/`); ISO `ExpiresAt` within `maxTtlDays` (A14) |
| 4 | 153 | AccessTokenController > rejects creating token with role caller does not hold | rewrite | C5 → T3 | authz-rbac/test/ported/; a role the owner lacks is refused by the token role policy (B24); like the row at line 215, the check may move to use time (B07: the ceiling drops roles the owner lacks), so the expectation may change. OPEN: B24/B07 (never above the owner) vs design §18.3(g) (role allowed when the owner's grants cover it); C5 or the integrator decides before T3 ports these rows. |
| 5 | 161 | AccessTokenController > deletes own token, foreign uuid not found | rewrite | C5 → T3 | authn-http/test/v3/; IDOR: a foreign token uuid is a 404 (keep verbatim in the T3 IDOR suite); revoke sets `RevokedAt`, the row is not deleted (A14) |
| 6 | 177 | AccessTokenController > grants and revokes role on own token | drop | C5 | N8b token routes are list, create and revoke; `TokenService` and the routes have no role edit (N6 task 2, N8b task 3); grant and revoke role routes have no 3.0 counterpart |
| 7 | 191 | AccessTokenController > refuses to revoke the last role with 400, not 500 | drop | C5 | Same: the revoke-role route is gone (N6 task 2, N8b task 3), so "last role" has no 3.0 case |
| 8 | 203 | AccessTokenController > a valid access token cannot manage tokens | adapt | C5 | authn-http/test/ (`src/token/`); a token cannot manage tokens (`NoTokenAuthPolicy` kept; A13, A14) |
| 9 | 220 | AccessTokenController > an impersonated session cannot mint or manage tokens | adapt | C5 | authn-http/test/ (`src/token/`); an impersonated session cannot mint or manage tokens, fixture sets `ImpersonatorId` (`NoImpersonationPolicy` kept; A20) |
| 10 | 263 | AccessTokenController > guards every route with both controller-scope policies in ONE mandatory group | rewrite | C5 → T3 | authn-http/test/v3/; guard layout: `NoTokenAuthPolicy` and `NoImpersonationPolicy` in one group, `RbacPolicy` replaced by `@Access` permissions (B23, C5 task 3) |
| 11 | 308 | AccessTokenController > a valid access token cannot reach ANY route of this controller | rewrite | C5 → T3 | authn-http/test/v3/; no route of the controller reachable by token, route list changes (A13, A14, SR-08) |

## test/token-middleware.test.ts

`TokenAuthMiddleware` bearer and `x-api-key` authentication. Mixed: rewrite per plan T3 where principal shape or order changes, adapt for the extractor behaviour, three drop; lane N8a.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 112 | TokenAuthMiddleware > authenticates a valid Bearer token | rewrite | N8a → T3 | authn-http/test/v3/; a bearer token resolves to a `Principal` in `req.storage.AuthnPrincipal`, no `User` or `TokenAuth` (A14, A23, B24) |
| 2 | 134 | TokenAuthMiddleware > keeps the whole effective role set authorizable, without pinning an active role | rewrite | N8a → T3 | authz-rbac/test/ported/; `ceiling.roles` = the token roles, no pinned active role (B24, B07) |
| 3 | 151 | TokenAuthMiddleware > clears the guest active role RbacMiddleware left behind | drop | N8a | Relies on 2.x `RbacMiddleware` stamping the guest `ActiveRole`; 3.0 writes one principal and anonymous is only the fallback when there is none (B10) |
| 4 | 161 | TokenAuthMiddleware > authenticates via fallback header | adapt | N8a | authn-http/test/ (`src/token/`); `x-api-key` extractor (N8a task 3) |
| 5 | 171 | TokenAuthMiddleware > leaves request untouched without token header | adapt | N8a | authn-http/test/ (`src/token/`); no credential leaves `AuthnPrincipal` unset |
| 6 | 181 | TokenAuthMiddleware > stays guest on invalid token, does not throw | adapt | N8a | authn-http/test/ (`src/token/`); an invalid token resolves to no principal and does not throw |
| 7 | 198 | TokenAuthMiddleware > ignores a duplicated token header instead of failing the request | adapt | N8a | authn-http/test/ (`src/token/`); a duplicated header reads as no token |
| 8 | 210 | TokenAuthMiddleware > does not override an existing session user | rewrite | N8a → T3 | authn-http/test/v3/; 3.0 order is key, token, session: a token wins over a session (N8a task 4, D26); 3.0 expectation differs |
| 9 | 221 | TokenAuthMiddleware > updates LastUsedAt on successful auth | adapt | N8a | authn-http/test/ (`src/token/`); last-used stamp, throttled (N6 task 3) |
| 10 | 234 | TokenAuthMiddleware > accepts a lowercase bearer scheme | adapt | N8a | authn-http/test/ (`src/token/`); lowercase bearer scheme |
| 11 | 252 | TokenAuthMiddleware > narrowing Role does not persist when the controller later updates the user | drop | N8a | `User.Role` is removed (H13) and the principal is a separate object, so narrowing cannot persist through `user.update()` |
| 12 | 274 | TokenAuthMiddleware > never logs the presented plaintext, and names the token by uuid when known | rewrite | N8a → T3 | authn-http/test/v3/; plaintext token never logged, rejections named by uuid (A14, A21) |
| 13 | 316 | TokenAuthMiddleware > runs after RbacMiddleware | drop | N8a | Two middlewares ordered against each other no longer exist: one `AuthnMiddleware` resolves key, token, session (N8a task 4); the order is tested by the row at line 210 |
| 14 | 325 | TokenAuthMiddleware > leaves Profile undefined on TokenAuth for a legacy token | rewrite | N8a → T3 | authn-http/test/v3/; a token without a profile leaves `attributes.profile` unset (B24, design §14) |
| 15 | 354 | TokenAuthMiddleware > profiles > stamps the token profile on TokenAuth | rewrite | N8a → T3 | authn-http/test/v3/; the token profile becomes `attributes.profile` (B24, design §14) |

## test/token-policies.test.ts

`TokenPolicy`, `NoTokenAuthPolicy` and `NoImpersonationPolicy`. `TokenPolicy` rows rewrite or drop, the two kept policies adapt (C5 task 3); lane C5.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 41 | token policies > TokenPolicy rejects request without token auth | rewrite | C5 → T3 | authz-rbac/test/ported/; `TokenPolicy` is gone, `@Access` accepts tokens; no credential gives 401 (B23, B10) |
| 2 | 48 | token policies > TokenPolicy accepts token-authenticated request with matching grant | rewrite | C5 → T3 | authz-rbac/test/ported/; a token with a matching grant passes (B24) |
| 3 | 54 | token policies > TokenPolicy rejects token-authenticated request without grant | rewrite | C5 → T3 | authz-rbac/test/ported/; a token without the grant gets 403 (B24, B07) |
| 4 | 61 | token policies > TokenPolicy errors on route without rbac descriptor | drop | C5 | `TokenPolicy` and the route descriptor it reads are removed; the missing-metadata case has no 3.0 policy |
| 5 | 83 | token policies > NoTokenAuthPolicy rejects token-authenticated request | adapt | C5 | authn-http/test/; `NoTokenAuthPolicy` kept (C5 task 3) |
| 6 | 89 | token policies > NoTokenAuthPolicy passes session request | adapt | C5 | authn-http/test/; fixture sets a session principal |
| 7 | 100 | token policies > NoTokenAuthPolicy passes guest request | adapt | C5 | authn-http/test/ |
| 8 | 106 | token policies > NoImpersonationPolicy rejects an impersonated session | adapt | C5 | authn-http/test/; `NoImpersonationPolicy` kept, reads `authn.impersonator` instead of `storage.Impersonator` (A20) |
| 9 | 114 | token policies > NoImpersonationPolicy passes an ordinary session | adapt | C5 | authn-http/test/ |
| 10 | 125 | token policies > NoImpersonationPolicy passes guest request | adapt | C5 | authn-http/test/ |

## test/token-policy-e2e.test.ts

Token authentication plus RBAC grants through a real server. Class: rewrite per plan T3 (B24, B07); lane C5, replacement by T3.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 90 | TokenPolicy e2e > valid bearer token reaches the route | rewrite | C5 → T3 | authz-rbac/test/ported/ and authn-http/test/v3/; a token reaches an `@Access` route (B24, A14, B23) |
| 2 | 102 | TokenPolicy e2e > valid fallback-header token reaches the route | rewrite | C5 → T3 | authn-http/test/v3/; an `x-api-key` token reaches the route (A14) |
| 3 | 112 | TokenPolicy e2e > anonymous request is rejected | rewrite | C5 → T3 | authn-http/test/v3/; anonymous gets 401 (B10, B23) |
| 4 | 117 | TokenPolicy e2e > expired token is rejected | rewrite | C5 → T3 | authn-http/test/v3/; an expired token never authenticates (A14) |
| 5 | 139 | TokenPolicy e2e > token without required grant is rejected | rewrite | C5 → T3 | authz-rbac/test/ported/; token roles narrower than the owner roles deny (B24, B07) |
| 6 | 163 | TokenPolicy e2e > authorizes a multi-role token with the full effective set, not just its first role | rewrite | C5 → T3 | authz-rbac/test/ported/; the whole token role set applies (B24 `ceiling.roles`) |
| 7 | 182 | TokenPolicy e2e > does not widen authorization beyond the token effective set | rewrite | C5 → T3 | authz-rbac/test/ported/; a ceiling never widens (B07) |

## test/two-factor-policy.test.ts

`TwoFactorAuthEnabled` policy. Class: adapt; lane N8b.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 17 | TwoFactorAuthEnabled > passes when 2fa is on system-wide | adapt | N8b | authn-http/test/ (`src/mfa/`); `TwoFactorAuthEnabled` stays as an `also` policy (design §17 migration table); the switch key moves from `rbac.twoFactorAuth.enabled` (§22.5) |
| 2 | 21 | TwoFactorAuthEnabled > answers 403 with a recognisable code when 2fa is off system-wide | adapt | N8b | authn-http/test/ (`src/mfa/`); 403 `E_2FA_SYSTEM_DISABLED` |

## test/two-factor-regenerate.test.ts

Login-window 2FA verification and session regeneration. Class: rewrite (pending session, A09); lane N8a.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 70 | TwoFactorAuthController.verifyToken — session regeneration on 2FA authorize > regenerates the session: new id issued, old id deleted, Authorized set, ssid cookie reset | rewrite | N8a → N8a | authn-http/test/v3/; MFA completion elevates the pending session and rotates the id (A07, A09, A10) |
| 2 | 101 | TwoFactorAuthController.verifyToken — session regeneration on 2FA authorize > activates a pending enrolment before authorizing the session | rewrite | N8a → N8a | authn-http/test/v3/; a pending enrolment is activated on a valid code, state in `DbMfaStore` (A10, A12) |
| 3 | 110 | TwoFactorAuthController.verifyToken — session regeneration on 2FA authorize > does not re-activate an account that already has 2fa on | rewrite | N8a → N8a | authn-http/test/v3/; an already enabled account is not re-activated (A10) |
| 4 | 135 | TwoFactorAuthController — login window policies > requires the 2fa window and an unauthorized session together | rewrite | N8a → N8a | authn-http/test/v3/; MFA window routes accept only a pending session (A09); policy names change |

## test/two-factor-self-service.test.ts

Self-service 2FA status, enable, confirm, disable, reset and the system switch. Mixed: adapt for stable status and guard rows, rewrite where fresh auth and recovery codes change the flow (A10, A13); lane N8b.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 101 | TwoFactorAuthUserController > status > reports enrolled | adapt | N8b | authn-http/test/ (`src/mfa/`); status route (A10); fixture state moves from metadata keys to `DbMfaStore` (A12) |
| 2 | 105 | TwoFactorAuthUserController > status > reports not enrolled | adapt | N8b | authn-http/test/ (`src/mfa/`) |
| 3 | 109 | TwoFactorAuthUserController > status > reports an enrolment that was started but never confirmed | adapt | N8b | authn-http/test/ (`src/mfa/`) |
| 4 | 115 | TwoFactorAuthUserController > enable > returns the provisioning URI once the password is confirmed | rewrite | N8b → N8b | authn-http/test/v3/; enrolment needs fresh auth or inline re-authentication, not a password in the body (A10, A13); 3.0 expectation differs |
| 5 | 125 | TwoFactorAuthUserController > enable > rotates the session id and resets the cookie after enrolling | rewrite | N8b → N8b | authn-http/test/v3/; A07 lists no rotation on enrol, N8b decides (A07, A13) |
| 6 | 141 | TwoFactorAuthUserController > enable > refuses without a valid password and does not enrol | rewrite | N8b → N8b | authn-http/test/v3/; a failed re-authentication does not enrol and counts into `reauth` (A13, SR-20) |
| 7 | 155 | TwoFactorAuthUserController > enable > rejects when 2FA is already enabled | adapt | N8b | authn-http/test/ (`src/mfa/`); already enrolled is refused |
| 8 | 162 | TwoFactorAuthUserController > enable, pending semantics > hands out a secret for an account that started but abandoned an enrolment | adapt | N8b | authn-http/test/ (`src/mfa/`); an abandoned enrolment may be started again |
| 9 | 171 | TwoFactorAuthUserController > confirm > confirms the enrolment and rotates the session | rewrite | N8b → N8b | authn-http/test/v3/; confirm activates the enrolment (A10); session rotation is not listed in A07 |
| 10 | 179 | TwoFactorAuthUserController > confirm > answers 403 on a bad code without rotating anything | adapt | N8b | authn-http/test/ (`src/mfa/`); a bad code is 403 `E_2FA_FAILED` and counts into the throttle (A10) |
| 11 | 188 | TwoFactorAuthUserController > confirm > rejects when there is no enrolment to confirm | adapt | N8b | authn-http/test/ (`src/mfa/`) |
| 12 | 193 | TwoFactorAuthUserController > confirm > lets a failure unrelated to a wrong code surface instead of reporting E_2FA_FAILED | adapt | N8b | authn-http/test/ (`src/mfa/`) |
| 13 | 203 | TwoFactorAuthUserController > confirm > rejects when the account is already enabled | adapt | N8b | authn-http/test/ (`src/mfa/`) |
| 14 | 210 | TwoFactorAuthUserController > disable > unenrols once the password is confirmed | rewrite | N8b → N8b | authn-http/test/v3/; disable needs fresh auth and a valid code or recovery code, not only the password (A10, A13); 3.0 expectation differs |
| 15 | 217 | TwoFactorAuthUserController > disable > rotates the session id and resets the cookie after unenrolling | rewrite | N8b → N8b | authn-http/test/v3/; rotation after disable (A07, A10) |
| 16 | 227 | TwoFactorAuthUserController > disable > refuses without a valid password and leaves 2FA in place | rewrite | N8b → N8b | authn-http/test/v3/; a hijacked session cannot strip the second factor (A10, A13); intent kept |
| 17 | 239 | TwoFactorAuthUserController > disable > rejects when 2FA is not enabled | adapt | N8b | authn-http/test/ (`src/mfa/`) |
| 18 | 246 | TwoFactorAuthUserController > reset > unenrols and issues a fresh secret in one call | rewrite | N8b → N8b | authn-http/test/v3/; 3.0 has no combined reset route: disable, then enrol with recovery codes (A10); N8b decides |
| 19 | 256 | TwoFactorAuthUserController > reset > refuses without a valid password and leaves the current device alone | rewrite | N8b → N8b | authn-http/test/v3/; a reauth failure leaves the device (A10, A13) |
| 20 | 267 | TwoFactorAuthUserController > reset > resets a pending enrolment too | rewrite | N8b → N8b | authn-http/test/v3/; re-enrol over a pending enrolment (A10) |
| 21 | 274 | TwoFactorAuthUserController > reset > rejects when there is nothing to reset | rewrite | N8b → N8b | authn-http/test/v3/; nothing to re-enrol (A10) |
| 22 | 279 | TwoFactorAuthUserController > reset > leaves the account without a device when enrol fails after the old one was removed | drop | N8b | 2.x non-atomic reset outcome; with no combined reset route and one transactional `disable`, the case does not exist |
| 23 | 293 | TwoFactorAuthUserController > system-wide switch > status reports the switch as on | adapt | N8b | authn-http/test/ (`src/mfa/`); `SystemEnabled` in status |
| 24 | 297 | TwoFactorAuthUserController > system-wide switch > status still answers when the switch is off, reporting it | adapt | N8b | authn-http/test/ (`src/mfa/`) |
| 25 | 326 | TwoFactorAuthUserController > system-wide switch > `${method} requires the system switch alongside its permission check` | adapt | N8b | authn-http/test/ (`src/mfa/`); the policy group pairs `Authenticated` or `FreshAuth` with `TwoFactorAuthEnabled` as `also` in one group (B23, D26: no `@Access` in authn-http); the dynamic loop drops `reset`, there is no combined reset route (rows 18 to 21) |
| 26 | 338 | TwoFactorAuthUserController > system-wide switch > status is not gated by the switch | adapt | N8b | authn-http/test/ (`src/mfa/`) |

## test/two-factor-wire-format.test.ts

System 2FA switch over a real HTTP request. Class: adapt; lane N8b.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 136 | system 2FA disabled, authorized caller (wire format) > reports the system switch as off instead of failing | adapt | N8b | authn-http/test/ (`src/mfa/`); stubs the authn policies (`Authenticated`, `FreshAuth`) and `AuthnMiddleware` instead of `RbacPolicy` and `RbacMiddleware`; no `AccessPolicy` in authn-http (D26) |
| 2 | 143 | system 2FA disabled, authorized caller (wire format) > refuses to enrol while the switch is off | adapt | N8b | authn-http/test/ (`src/mfa/`); 403 `E_2FA_SYSTEM_DISABLED` |

## test/whoami.test.ts

`LoginController.whoami` answer for active and mid-2FA sessions. Class: rewrite (pending whoami, SR-07, B25); lane N8a.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 142 | LoginController.whoami > reports Authorized: true for a fully authorized session | rewrite | N8a → N8a | authn-http/test/v3/; the whoami answer for an active session carries `Access` (B25); whether `Authorized` stays is for N8a to decide |
| 2 | 162 | LoginController.whoami > sends every assigned role, not the flattened relation | rewrite | N8a → N8a | authn-http/test/v3/; the role list comes from the principal and `Access`, `User.Role` is removed (H13, B25) |
| 3 | 171 | LoginController.whoami > reports Authorized: false for a session mid-2FA | rewrite | N8a → N8a | authn-http/test/v3/; `SR-07 pending whoami shows only MfaRequired` (A09, D25); 3.0 expectation differs |
| 4 | 190 | LoginController.whoami > reports Authorized: true when the session carries no Authorized key | rewrite | N8a → N8a | authn-http/test/v3/; a 2.x row without `Authorized` is handled by N2 task 4 (pending vs active state); A07 lazy migration covers raw session ids only |

## test/z-account-session-context.test.ts

`SessionContextProvider` fields on whoami, login payload and role switch. Class: rewrite per plan T2; lane C3. Rows use fakes of the extension inputs; no `users` or `authz*` dependency in authn-http (D26).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 166 | SessionContextProvider > adds provider fields to whoami, resolved for the session active role | rewrite | C3 → T2 | authn-http/test/v3/; `AuthnResponseExtension` runs on whoami (B25) |
| 2 | 172 | SessionContextProvider > adds provider fields to the login-style payload | rewrite | C3 → T2 | authn-http/test/v3/; the extension runs on the login answer; `buildUserWithGrants` is deleted by C3 (B25) |
| 3 | 178 | SessionContextProvider > adds provider fields to GET /auth/active-role | rewrite | C3 → T2 | authn-http/test/v3/; the extension runs on role switch, `GET /auth/active-role` is replaced (B25, A26) |
| 4 | 184 | SessionContextProvider > resolves provider fields for the role switched to, not the one switched from | rewrite | C3 → T2 | authn-http/test/v3/; the extension resolves for the role switched to (A26, B25) |

## test/z-login-failure-parity.test.ts

Failed logins give one answer (account enumeration). Class: adapt (A02); lane N8a.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 89 | LoginController — failed logins are indistinguishable > answers Unauthorized for an email that is not registered | adapt | N8a | authn-http/test/; an unknown email gives 401 `E_AUTH_FAILED` (A02, SR-04) |
| 2 | 101 | LoginController — failed logins are indistinguishable > answers Unauthorized for a registered email with the wrong password | adapt | N8a | authn-http/test/; a wrong password gives the same 401 (A02) |
