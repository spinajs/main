---
"@spinajs/http": minor
---

`@RateLimit(options)`: an options form next to the positional `@RateLimit(limit, windowSeconds, by)`, which is unchanged. `config` names a configuration key read once when the route is mounted: `{ limit, windowSeconds, by, headers }` merged over the required `default`, or `false` to leave the middleware off the route. A wrong configured value fails the route registration with `InvalidOption` naming the key. `answer` replaces the throttled 429 with the route's own answer (`(retryAfterSeconds) => Response`), `headers` (default false) sends the `X-RateLimit-*` headers, and the middleware's `Retry-After` next to an `answer`, only when `true`, and `key(ctx)` counts on a key of the route's own (stored as `key:<value>`), falling back to `by`. The store key layout is unchanged. Wrong options (unknown keys, a non-function `answer` or `key`, a non-boolean `headers`) fail the registration with `InvalidArgument`. New exports: `IRateLimitOptions`, `IRateLimitSettings`. `RateLimitMiddleware`'s `limit`, `windowSeconds` and `by` are now getters of the effective settings, and a subclass that overrides `onRegister` without calling `super.onRegister` now fails its requests closed.

`IThrottleRule.headers` (`http.throttle.rules[].headers`, default false): `true` sends the `X-RateLimit-*` headers on the requests the rule counts; off, the 429 carries only `Retry-After`.

The `X-RateLimit-*` headers are opt-in: the configured value (or `default`) of a `@RateLimit({ config })` may set `headers`, which wins over the decorator's; a decorator with `headers: false` keeps the key out of the configured value and `default` (`InvalidOption` / `InvalidArgument`). `IRateLimitSettings` gains `headers?`; new export `RateLimitDefault` (the settings with `limit`, `windowSeconds` and `by` required, `headers` optional); `rateLimitSchema` accepts `headers`, except with `opts.headers === false`.

**Breaking:** `http.throttle` rules and `@RateLimit` no longer send `X-RateLimit-*`; set `headers: true` to keep them.

`@RateLimit({ config: false })` declares a route unlimited in code: nothing is mounted, a global `http.routes.middlewares` floor is dropped, and a controller `@RateLimit` is off on that route. New export `rateLimitSchema(default, route, opts?)`: the configuration schema of one configured limit (`false` or `{ limit?, windowSeconds?, by?, headers? }`).

For a package with several configured routes: `RateLimitDefaults<N>` (a table of `RateLimitDefault` per route name), `rateLimitsSchema(defaults, routes, description?, opts?)` (the schema of a `rateLimit` object, one `rateLimitSchema` entry per name, an unknown name refused) and `configuredRateLimit(root, defaults, opts?)` (a factory `(name, { answer?, key? }) => @RateLimit` over `<root>.<name>`; `opts.headers` fixes the headers of every route it declares).
