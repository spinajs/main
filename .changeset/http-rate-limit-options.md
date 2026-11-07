---
"@spinajs/http": minor
---

`@RateLimit(options)`: an options form next to the positional `@RateLimit(limit, windowSeconds, by)`, which is unchanged. `config` names a configuration key read once when the route is mounted: `{ limit, windowSeconds, by }` merged over the required `default`, or `false` to leave the middleware off the route. A wrong configured value fails the route registration with `InvalidOption` naming the key. `answer` replaces the throttled 429 with the route's own answer (`(retryAfterSeconds) => Response`), `headers: false` drops the `X-RateLimit-*` headers and the middleware's `Retry-After`, and `key(ctx)` counts on a key of the route's own (stored as `key:<value>`), falling back to `by`. The store key layout is unchanged. Wrong options (unknown keys, a non-function `answer` or `key`, a non-boolean `headers`) fail the registration with `InvalidArgument`. New exports: `IRateLimitOptions`, `IRateLimitSettings`. `RateLimitMiddleware`'s `limit`, `windowSeconds` and `by` are now getters of the effective settings, and a subclass that overrides `onRegister` without calling `super.onRegister` now fails its requests closed.

`IThrottleRule.headers` (`http.throttle.rules[].headers`, default true): `false` leaves the `X-RateLimit-*` headers off the requests the rule counts, for routes whose answers must not reveal a limiter; the 429 keeps `Retry-After`.

`@RateLimit({ config: false })` declares a route unlimited in code: nothing is mounted, a global `http.routes.middlewares` floor is dropped, and a controller `@RateLimit` is off on that route. New export `rateLimitSchema(default, route)`: the configuration schema of one configured limit (`false` or `{ limit?, windowSeconds?, by? }`).
