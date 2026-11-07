---
"@spinajs/http": minor
---

`@RateLimit(options)`: an options form next to the positional `@RateLimit(limit, windowSeconds, by)`, which is unchanged. `config` names a configuration key read once when the route is mounted: `{ limit, windowSeconds, by }` merged over the required `default`, or `false` to leave the middleware off the route. A wrong configured value fails the route registration with `InvalidOption` naming the key. `answer` replaces the throttled 429 with the route's own answer (`(retryAfterSeconds) => Response`), `headers: false` drops the `X-RateLimit-*` headers and the middleware's `Retry-After`, and `key(ctx)` counts on a key of the route's own (stored as `key:<value>`), falling back to `by`. The store key layout is unchanged. New exports: `IRateLimitOptions`, `IRateLimitSettings`.
