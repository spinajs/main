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
  in the key. A `@Header`, `@Cookie` or `@UserAgent` argument needs its header in `vary`, `@Referer()` both `referer`
  and `referrer`, and `@Header()` must name its header (`@Header('x-region')`): http names an argument only after the
  routes are registered. Any other argument (session, IP, the current principal or user, `@Lang()`, the orm-http model
  and filter arguments, an application's own resolver) fails the registration: cache such a route with scope
  `'principal'`. An action that takes `@Req()` or `@Res()` fails the registration too.
  http also passes `req`, `res` and `next` after the declared arguments: an action with more parameters than declared
  arguments fails the registration, but one that reads them through a default or rest parameter or `arguments` cannot
  be seen. A `'tenant'` or `'shared'` action must not read the request at all; it takes what it needs as `@Query`,
  `@Param` or `@Header` arguments.
- A route that reads the request body (`@Body`, a form, a file, the raw body, `@ContentDigest`, `@RequestStream`)
  fails the registration on every scope, per principal too: a GET body is in no key.
- A `'tenant'` route fails the registration unless something puts the tenant into the key: `@spinajs/tenancy-http`,
  an `IdempotencyScopePart` or a `CacheScope`. The check cannot tell a tenant part from another one (a region part
  passes it too), and a request without a tenant gets no tenant part: such requests share their replies.
- What the action reads of the request without an argument is not in the key either. On a `'tenant'` or `'shared'`
  route a reply that builds URLs from the request host (`req.hostname`, `req.protocol`) needs `vary: ['host']`, and
  `x-forwarded-host` (and `x-forwarded-proto`) behind a proxy: otherwise one caller's `Host` header plants its links in
  the reply every caller gets. An action that reads `Accept-Language` itself needs `vary: ['accept-language']`, with or
  without `@spinajs/intl-http`, which never reads that header.
- On a `'tenant'` or `'shared'` route a reply whose route sets its own `Vary` naming `Cookie` or `Authorization` is
  not stored: it was made for one caller. Only a `Vary` the route sets itself is checked: `@spinajs/intl-http` adds
  `Vary: Cookie, X-Lang` and CORS `Vary: Origin` to every reply, and the language intl-http detects (from `?lang`, the
  `lang` cookie or `X-Lang`) is in the key. intl-http joins its names into a `Vary` the route sets, so such a route is
  not stored on a wider scope. A header the body depends on belongs in `vary`.
- A reply that says `Cache-Control: no-cache` is not stored: a hit never asks the action again.
- A hit sends the stored `Content-Type`, `Location`, `ETag` and, of the headers the route set in its reply, only those
  that describe the body (`Content-Language`, `Content-Disposition`, `Last-Modified`, `Link`, `Cache-Control`,
  `Expires`, `Vary`), on every scope: a route's `X-Request-Id`, CSRF token or rate-limit value belongs to one request
  or session, and one principal has many. A header like that is set by a middleware, which sets it again on a hit.
- The key holds no build or version of the application: a reply cached before a deployment is served after it until
  its ttl, and two versions behind one shared store exchange their replies. Invalidate the route's tags on deploy, or
  register a `ResponseCacheKeyPart` that returns the build id.

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `cache.http.timeout` | `250` | Milliseconds the response cache waits for its cache to answer a lookup or a store. Past it the request runs uncached and the route logs a warning, at most once per call and minute. A store call that answers later may still store the reply, under the tag versions read before the action ran, so an invalidation in between still wins. A key part or a cache call that throws is read the same way. |
