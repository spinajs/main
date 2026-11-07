---
"@spinajs/http": minor
---

New `@RateLimit(limit, windowSeconds, by = 'ip')` route decorator, mounting the new `RateLimitMiddleware` (`@NewInstance`, registered as `RouteMiddleware`, `'outer'` stage). It counts a fixed window per route (method and mounted path, limit and window) in the registered `ThrottleStore`, per client address (IPv6 per `http.throttle.ipv6Prefix` network) or per authenticated principal (`req.storage.Principal`, else `req.storage.AuthnPrincipal`; an anonymous request per address). It sets the `X-RateLimit-*` headers and over the limit answers the same 429 with `Retry-After` and body as `ThrottleMiddleware`. `limit: 0` closes the route (429 without `Retry-After`, nothing counted). Wrong arguments fail the route registration. `ThrottleMiddleware` now builds its answer with the same shared code; its answer is unchanged.
