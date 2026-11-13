---
"@spinajs/authn-oidc": minor
---

`GET /auth/oidc/:provider` and its callback are rate limited by default, 60 a minute per client address each (`authn.oidc.rateLimit.begin` and `.callback`: `{ limit, windowSeconds, by }` merged over the default, or `false`; `headers` is refused). A refused client gets the one OIDC failure answer with `Retry-After` (a 303 to `authn.oidc.redirects.failure` for a navigation, else the 401 login failure body, the flow cookie cleared), with no `X-RateLimit-*` headers. Back-channel logout is declared `@RateLimit({ config: false })`: never limited, not even by a global `http.routes.middlewares` floor. `OidcConfig` gains `rateLimit` (`OidcRateLimitSetting`). The throttled answer takes the failure page and the env from the validated `OidcProviders` options. New exports: `AUTHN_OIDC_RATE_LIMITS`, `OidcRateLimit`, `OidcThrottledResponse`, `oidcThrottled`, `oidcFailure`, `isNavigation`.
