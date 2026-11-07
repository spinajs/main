---
"@spinajs/authn-oidc": minor
---

`GET /auth/oidc/:provider` and its callback are rate limited by default, 60 a minute per client address each (`authn.oidc.rateLimit.begin` and `.callback`: `{ limit, windowSeconds, by }` merged over the default, or `false`). A refused client gets the one OIDC failure answer with `Retry-After` (a 303 to `authn.oidc.redirects.failure` for a navigation, else the 401 login failure body, the flow cookie cleared), with no `X-RateLimit-*` headers. Back-channel logout is never limited. New exports: `AUTHN_OIDC_RATE_LIMITS`, `OidcRateLimit`, `OidcThrottledResponse`, `oidcThrottled`, `oidcFailure`, `isNavigation`.
