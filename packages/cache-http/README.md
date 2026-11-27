# `@spinajs/cache-http`

A response cache for SpinaJS http routes. `@ResponseCache({ ttl: '5m' })` on a GET route stores its JSON reply in a
named cache of `@spinajs/cache`; a later request with the same key gets the stored reply and the action does not run.
The key is per principal unless the route says `scope: 'tenant'` or `'shared'`. The route's policies run on every
request, a hit included; what a stored reply holds does not change until it ends.

- `swr`: an expired reply is served while one request of the process runs the route again.
- Concurrent requests of one key wait for the one that runs the route, at most `cache.http.timeout`.

Nothing is cached unless a route carries the decorator. See `docs/cache-http/README.md`: the key, what is stored, the
arguments a shared route may take, and the limits of this version.
