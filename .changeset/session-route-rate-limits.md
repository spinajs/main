---
"@spinajs/authn-http": minor
"@spinajs/authn-oidc": minor
"@spinajs/authz-http": minor
"@spinajs/authz-http-admin": minor
"@spinajs/users-http": minor
"@spinajs/teams-http": minor
---

Config-backed `@RateLimit`s, on by default, on the routes with a session that spend something per call. Each reads a config key once when the route is mounted (`{ limit?, windowSeconds?, by? }` over the shipped default, or `false` for no limit), and each key has a schema entry that refuses an unknown name or a value the middleware cannot enforce.

- `@spinajs/authn-http`: `authn.http.rateLimit.*` on the MFA, step-up, re-authentication, active role, impersonation, password change, verification request, token, key, passkey, MFA enrolment and credential admin routes. The pending-session MFA routes count an HMAC of the restored pending session under `http.cookie.secret` (falling back to the client address) and keep their uniform answer without `X-RateLimit-*`; the others count the principal and answer authn's 429 `throttled` body. New exports: `AUTHN_SESSION_RATE_LIMITS`, `SessionRateLimit`, `pendingSessionKey`, `rateLimitSettingsSchema`.
- `@spinajs/authn-oidc`: `authn.oidc.rateLimit.link` and `.reauth` (`AUTHN_OIDC_SESSION_RATE_LIMITS`); `rateLimit` joins the keys `authn.oidc` accepts.
- `@spinajs/authz-http`: `authz.http.rateLimit.checks`, `.events`, `.explain`; the helpers `rateLimitsSchema`, `rateLimitSettingsSchema` and `configuredRateLimit`.
- `@spinajs/authz-http-admin`: `authz.http.admin.rateLimit.commands` and `.writes` (schema module `authz.http.admin.rateLimit`).
- `@spinajs/users-http`: `users.http.rateLimit.create`, `.security`, `.list`, `.metadata` (schema module `users.http.rateLimit`).
- `@spinajs/teams-http`: `teams.http.rateLimit.create`, `.invite`, `.resend`, `.accept` (schema module `teams.http.rateLimit`).

Principal-keyed limits count the impersonated user while an admin impersonates: the impersonator spends that user's budget.
