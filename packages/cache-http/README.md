# `@spinajs/cache-http`

A response cache for SpinaJS http routes. `@ResponseCache({ ttl: '5m' })` on a GET route stores its JSON reply in a
named cache of `@spinajs/cache`; a later request with the same key gets the stored reply and the action does not run.
The key is per principal unless the route says `scope: 'tenant'` or `'shared'`. The route's policies run on every
request, a hit included; what a stored reply holds does not change until it ends.

- `swr`: an expired reply is served while one request of the process runs the route again.
- Concurrent requests of one key wait for the one that runs the route, at most `cache.http.waitTimeout`.

Nothing is cached unless a route carries the decorator. A `'tenant'` or `'shared'` reply is the reply of the first
caller, sent to every caller with the same key: such a route must not read the request outside its declared
`@Query`, `@Param` and `@Header` arguments (the registration refuses most other reads, not all), and a revoked row or
field stays in a stored reply until it ends. See
[docs/cache-http/README.md](https://github.com/spinajs/main/blob/v4/docs/cache-http/README.md): the key, what is
stored, the arguments a shared route may take, and the limits of this version.
