# `@spinajs/cache-http`

A response cache for SpinaJS http routes. `@ResponseCache({ ttl: '5m' })` on a GET route stores its JSON reply in a
named cache of `@spinajs/cache`; a later request with the same key gets the stored reply and the action does not run.
The key is per principal unless the route says `scope: 'tenant'` or `'shared'`. The policies run on every request.

Nothing is cached unless a route carries the decorator.

Limits of this version:

- A per-principal route reads the principal `@spinajs/authz-http` resolves (`req.storage.Principal`). With
  `@spinajs/authn-http` alone, whose principal is `req.storage.AuthnPrincipal`, such a route runs uncached.
- `@spinajs/authn-http` sets `Cache-Control: no-store` on every request it signs in, and a `no-store` reply is never
  stored: for a signed-in caller only a route that sets its own `Cache-Control` in its reply is stored. The route
  logs one warning.
- `static PerPrincipalReply = true` is read on route middlewares (of the route, its controller and
  `http.routes.middlewares`) and on the data transformer `x-data-transform` names, not on server middlewares.
- `ResponseCacheMiddleware` is mounted by `@ResponseCache()`; mounted with `@Middleware()` it fails the registration.
