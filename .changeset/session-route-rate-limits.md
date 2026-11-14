---
"@spinajs/authn-http": minor
"@spinajs/authn-oidc": minor
"@spinajs/authz-http": minor
"@spinajs/authz-http-admin": minor
"@spinajs/users-http": minor
"@spinajs/teams-http": minor
---

Config-backed `@RateLimit`s, on by default, on the routes with a session that spend something per call. Each reads a config key once when the route is mounted (`{ limit?, windowSeconds?, by? }` over the shipped default, or `false` for no limit), and each key has a schema entry that refuses an unknown name or a value the middleware cannot enforce. No route sends `X-RateLimit-*` by default; the authz, users and teams keys take `headers: true` to send them, the authn and OIDC keys refuse `headers`.

- `@spinajs/authn-http`: `authn.http.rateLimit.*` on the MFA, step-up, re-authentication, active role, impersonation, password change, verification request, token, key, passkey, MFA enrolment and credential admin routes, beside the anonymous routes' entries. The pending-session MFA routes count the restored pending session (`pendingSessionKey`, an HMAC under `http.cookie.secret`, falling back to the client address) (so does MFA enrolment for a session forced to enrol); the others count the principal. No route sends `X-RateLimit-*`: the code and password checks (MFA, step-up, re-authentication, password change) answer as their service throttle does, the others with authn's 429 `throttled` body. New exports: `AUTHN_HTTP_SESSION_RATE_LIMITS`, `AUTHN_HTTP_SESSION_RATE_LIMITED_ROUTES`, `AuthnSessionRateLimit`.
- `@spinajs/authn-oidc`: `authn.oidc.rateLimit.link` and `.reauth` (`AUTHN_OIDC_SESSION_RATE_LIMITS`, `OidcSessionRateLimit`), beside begin and callback, with their failure answer and no `X-RateLimit-*`. New export `AUTHN_OIDC_RATE_LIMITED_ROUTES`.
- `@spinajs/authz-http`: `authz.http.rateLimit.checks`, `.events`, `.explain`, built on `@spinajs/http`'s `rateLimitsSchema`/`configuredRateLimit`.
- `@spinajs/authz-http-admin`: `authz.http.admin.rateLimit.commands` and `.writes` (schema module `authz.http.admin.rateLimit`).
- `@spinajs/users-http`: `users.http.rateLimit.create`, `.security`, `.list`, `.metadata` (schema module `users.http.rateLimit`).
- `@spinajs/teams-http`: `teams.http.rateLimit.create`, `.invite`, `.resend`, `.accept` (schema module `teams.http.rateLimit`).

Principal-keyed limits count the impersonated user while an admin impersonates: the impersonator spends that user's budget.
