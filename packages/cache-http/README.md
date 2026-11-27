# `@spinajs/cache-http`

A response cache for SpinaJS http routes. `@ResponseCache({ ttl: '5m' })` on a GET route stores its JSON reply in a
named cache of `@spinajs/cache`; a later request with the same key gets the stored reply and the action does not run.
The key is per principal unless the route says `scope: 'tenant'` or `'shared'`. The route's policies run on every
request, a hit included; what a stored reply holds does not change until its ttl (see the first two limits).

Nothing is cached unless a route carries the decorator.

Limits of this version:

- A revoked route permission is refused at once, because the policies run on a hit. The rows an `.accessible()` or
  `@spinajs/authz-orm`-filtered query returned for the caller are not checked again: they stay in a stored reply until
  its ttl, at most `cache.maxTtl` (default `1h`), so a caller whose access to a row was revoked keeps seeing it from
  the cache until then. Cache a row-filtered list with scope `'principal'` and a short ttl, or do not cache it.
- A hit runs no query, so `@AuditReads` of `@spinajs/audit-orm` records only the miss. Do not cache a route that reads
  an audited model, or accept that its hits leave no read record. `@spinajs/audit-http`'s `Audit` and the policy
  decision log do run on a hit.
- A per-principal route reads the principal `@spinajs/authz-http` resolves (`req.storage.Principal`). With
  `@spinajs/authn-http` alone, whose principal is `req.storage.AuthnPrincipal`, such a route runs uncached.
- `@spinajs/authn-http` sets `Cache-Control: no-store` on every request it signs in, and a `no-store` reply is never
  stored: for a signed-in caller only a route that sets its own `Cache-Control` in its reply is stored. The route
  logs one warning.
- `static PerPrincipalReply = true` is read on route middlewares (of the route, its controller and
  `http.routes.middlewares`) and on the data transformer `x-data-transform` names, not on server middlewares.
- `ResponseCacheMiddleware` is mounted by `@ResponseCache()`; mounted with `@Middleware()` it fails the registration.
- On a `'tenant'` or `'shared'` route only arguments from the URL (`@Query`, `@Param`), the container and `Accept` are
  in the key. A `@Header`, `@Cookie`, `User-Agent` or `Referer` argument needs its header in `vary`; any other
  argument (session, IP, body, the current principal or user, an application's own resolver) fails the registration:
  cache such a route with scope `'principal'`. An action that takes `@Req()` or `@Res()` logs a warning at registration:
  what it reads of the request is not in the key.
- A `'tenant'` route fails the registration unless something puts the tenant into the key: `@spinajs/tenancy-http`,
  an `IdempotencyScopePart` or a `CacheScope`.
- What the action reads of the request without an argument is not in the key either. On a `'tenant'` or `'shared'`
  route a reply that builds URLs from the request host (`req.hostname`, `req.protocol`) needs `vary: ['host']`, and
  `x-forwarded-host` (and `x-forwarded-proto`) behind a proxy: otherwise one caller's `Host` header plants its links in
  the reply every caller gets. Without `@spinajs/intl-http` the language is not in the key: an action that reads
  `Accept-Language` itself needs `vary: ['accept-language']`.
- On a `'tenant'` or `'shared'` route a reply whose `Vary` names `Cookie` or `Authorization` is not stored: it was
  made for one caller. Other names are not checked against the key (CORS adds `Vary: Origin` to every reply); a
  header the body depends on belongs in `vary`.
- A hit sends the stored `Content-Type`, `Location`, `ETag` and the headers the route set in its reply. On a
  `'tenant'` or `'shared'` route only the route's headers that describe the body are kept (`Content-Language`,
  `Content-Disposition`, `Last-Modified`, `Link`, `Cache-Control`, `Expires`, `Vary`): a header meant for one caller
  (a CSRF token) is set by a middleware, which sets it again on a hit.
- The key holds no build or version of the application: a reply cached before a deployment is served after it until
  its ttl, and two versions behind one shared store exchange their replies. Invalidate the route's tags on deploy, or
  register a `ResponseCacheKeyPart` that returns the build id.
