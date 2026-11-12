# Throttling

`ThrottleMiddleware` caps how many requests one client address may send to a path in a fixed time window, before any route code runs. Rules match by path prefix and HTTP method; a request over the limit gets 429 with `Retry-After`. Counters live in a `ThrottleStore`: in process memory by default, or in a shared store you provide for several instances.

It is off by default. For a limit on one route, declared next to the route, use [`@RateLimit`](#per-route-limits-ratelimit): it counts in the same `ThrottleStore` and answers the same 429.

`ThrottleMiddleware` does **not** replace the login throttle of `@spinajs/authn`, which limits per account and per IP on the login flow itself.

## How it works

When it resolves (Order 3, after `RealIp`):

1. Reads `http.throttle`. Not enabled: `isEnabled()` is false and nothing is mounted.
2. Checks every rule: `limit` must be a finite number ≥ 0 and `windowSeconds` a finite number > 0, else `InvalidOption` stops the boot.
3. No rules: logs a warning and mounts nothing.

Per request (`onBefore`):

1. Finds the **first** rule whose `path` is a prefix of `req.path` on a segment boundary (case-insensitive) and whose `methods` include the request method (or that has no `methods`). No rule: the request goes on.
2. Builds the key `<ip>:<rule.path>:<methods or *>`. The address is `req.storage.realIp`, else the socket address. An IPv6 address is replaced by its network, `<network>/<prefix>` with `http.throttle.ipv6Prefix`, so a client that owns a whole /64 cannot get a fresh window per address. IPv4 and IPv4-mapped addresses are keyed whole.
3. Calls `ThrottleStore.increment(key, windowSeconds)`.
4. Only for a rule with `headers: true`: sets `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (Unix seconds).
5. Over the limit: returns the 429 `Response` with `Retry-After` (seconds, at least 1) and `{ error: { code: 'E_TOO_MANY_REQUESTS', message: 'Too many requests, try again later' } }`. It goes through the reply pipeline, so the `onAfter` of the server middlewares entered before it (timing headers, for one) see it.
6. A store that throws: the request fails closed; the global error answer answers it.

`MemoryThrottleStore` keeps fixed windows in a `Map`. A window starts at the first hit and resets after `windowSeconds`. Expired keys are dropped on their next hit and in a full sweep every 10,000 increments (`MemoryThrottleStore.SWEEP_INTERVAL`).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.throttle.enabled` | `boolean` | `false` | | Turns the middleware on. |
| `http.throttle.ipv6Prefix` | `integer` | `64` | 16 to 128 | IPv6 clients are counted per prefix of this many bits. `@RateLimit` counts the same; authn's ip keys take it unless `authn.throttle.ipv6Prefix` is set. |
| `http.throttle.rules` | `IThrottleRule[]` | `[]` | | Checked in order; the first match wins. |
| `http.throttle.rules[].path` | `string` | required | non-empty path prefix | Matched against the request path, including `http.controllers.route.prefix`. |
| `http.throttle.rules[].methods` | `string[]` | all methods | HTTP methods | Methods the rule applies to. |
| `http.throttle.rules[].limit` | `integer` | required | ≥ 1 in the schema; 0 refuses every request | Requests allowed per window per address. |
| `http.throttle.rules[].windowSeconds` | `integer` | required | ≥ 1 | Window length. |
| `http.throttle.rules[].headers` | `boolean` | `false` | | `true`: `X-RateLimit-*` headers on every request the rule counts, the 429 included. Off, the 429 carries only `Retry-After`. |

```ts
export default {
  http: {
    throttle: {
      enabled: true,
      rules: [
        // Most specific first: the first matching rule wins.
        { path: '/api/v1/auth/password', methods: ['POST'], limit: 5, windowSeconds: 300 },
        { path: '/api/v1/auth', methods: ['POST'], limit: 10, windowSeconds: 60 },
        { path: '/api/v1/search', limit: 120, windowSeconds: 60 },
      ],
    },
  },
};
```

### Opting in to the rate-limit headers

Neither an `http.throttle` rule nor `@RateLimit` sends `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` unless asked: reporting the remaining budget is a choice. A rule opts in with `headers: true`, a route with `@RateLimit({ ..., headers: true })` or with `headers: true` in its configured value. Without them, the 429 still carries `Retry-After`. Turn them on for an API whose clients pace themselves on the budget; leave them off where the answers must not reveal a limiter.

```ts
export default {
  http: {
    throttle: {
      enabled: true,
      rules: [{ path: '/api/v1/search', limit: 120, windowSeconds: 60, headers: true }],
    },
  },
};
```

### Rules match the resolved path

A rule is compared with `req.path`, the path the client requested. A controller whose `@BasePath({ config, default })` is moved by configuration (the credential admin routes under `authn.http.admin.basePath`, the authz admin routes under `authz.http.admin.basePath`) answers on its configured path, so a rule written for the default path stops covering it. Write the rule for the path the app serves, and include `http.controllers.route.prefix`.

### Recommended rules for the authn routes

The authn throttle already limits guessing per account and per IP, but only on the routes that reach it. These rules cap the raw request volume per address before any handler runs. Start from them and adjust the numbers to your traffic; put the most specific rule first.

```ts
export default {
  http: {
    throttle: {
      enabled: true,
      ipv6Prefix: 64,
      rules: [
        { path: '/auth/register', methods: ['POST'], limit: 10, windowSeconds: 3600 },
        { path: '/auth/password', methods: ['POST'], limit: 10, windowSeconds: 600 },
        { path: '/auth/code', methods: ['POST'], limit: 10, windowSeconds: 600 },
        { path: '/auth/verify', methods: ['POST'], limit: 20, windowSeconds: 600 },
        { path: '/auth/passkeys/challenge', methods: ['POST'], limit: 30, windowSeconds: 60 },
        { path: '/auth/keys/challenge', methods: ['POST'], limit: 30, windowSeconds: 60 },
        { path: '/auth/tokens/revoke', methods: ['POST'], limit: 20, windowSeconds: 600 },
        { path: '/auth', methods: ['POST'], limit: 60, windowSeconds: 60 },
      ],
    },
  },
};
```

The counters are per process unless you register a shared `ThrottleStore`. Behind a proxy set `http.trustProxy` (with `@spinajs/authn-http`, `authn.http.trustProxy` counts too), or every client shares the proxy's address.

## Per-route limits: `@RateLimit`

`@RateLimit(limit, windowSeconds, by = 'ip')`, or `@RateLimit(options)` (see [the options form](#the-options-form-configured-limits-answer-headers-key)), mounts `RateLimitMiddleware` on a route, or on every route of a controller. It counts requests in a fixed window in the registered `ThrottleStore` and over the limit answers the same 429 body with `Retry-After` as `ThrottleMiddleware`. The `X-RateLimit-*` headers are [opt-in](#opting-in-to-the-rate-limit-headers), with the options form's `headers: true`. No `http.throttle.enabled` is needed.

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `limit` | `integer` | required | Requests allowed per window. `0` closes the route: every request gets the 429, without `Retry-After` or `X-RateLimit-Reset`, and nothing is counted. |
| `windowSeconds` | `number` | required | Window length, > 0. |
| `by` | `'ip' | 'principal'` | `'ip'` | `'ip'`: per client address, an IPv6 address per `http.throttle.ipv6Prefix` network, as `ThrottleMiddleware` counts. `'principal'`: per authenticated principal (`req.storage.Principal` from `@spinajs/authz-http`, else `req.storage.AuthnPrincipal`); an anonymous request is counted per address. |

```ts sample
import { BaseController, BasePath, Ok, Post, RateLimit } from '@spinajs/http';

@BasePath('reports')
export class ReportController extends BaseController {
  // A burst and a sustained limit count apart.
  @Post()
  @RateLimit(5, 60, 'principal')
  @RateLimit(50, 3600, 'principal')
  public generate() {
    return new Ok({ queued: true });
  }

  @Post()
  @RateLimit(10, 600)
  public contact() {
    return new Ok();
  }
}
```

- Each route counts apart: the key is the route's method and mounted path, the limit, the window and the client (`ip:<address>` or `principal:<type>:<id>`). A `ThrottleMiddleware` rule covering the same path counts on its own key; a request then pays both.
- It is an `'outer'` route middleware: it runs after the policy gate and before the route's other middlewares, the argument extraction and the action. A request a policy refuses is not counted.
- Other `'outer'` middlewares, such as `@Idempotent()`, share its stage, and there the bottom decorator runs first. With `@Idempotent()` below `@RateLimit`, a retry the idempotency key answers (a 409 while the first request runs, a replayed reply) is answered before the limit counts it and carries no `X-RateLimit-*` headers. Put `@RateLimit` below `@Idempotent()` to count every attempt.
- Wrong arguments (a non-integer or negative `limit`, a window that is not a positive number, an unknown `by`) or an `http.throttle.ipv6Prefix` outside 16..128 fail the route registration with `RouteRegistrationException`. With the options form, wrong options in code (an unknown option, an `answer` or `key` that is not a function, a `headers` that is not a boolean, a missing `default` next to `config`) fail it with `InvalidArgument`, a wrong configured value with `InvalidOption` naming the key; both are wrapped in `RouteRegistrationException`. Options and configured values are checked by `DataValidator` (`@spinajs/validation`) against the `http.rateLimit.*` schemas, never coerced: `@spinajs/http` adds `http.rateLimit.` to `validation.strict.idPrefixes` ([strict schema ids](../validation/02-validator-options.md#strict-schema-ids)), so `"5"` or `headers: 1` is refused instead of becoming `5` or `true`. An app config with the boolean form `validation.strict: true` replaces that object: the validator then keeps only the shipped `authn.` and `authz.` prefixes and coerces the `@RateLimit` options again. Use `validation.strict: { idPrefixes: [], ajvStrict: true }` instead.
- A store that throws fails the request closed, as for `ThrottleMiddleware`.
- With two limits on a route that both send headers, the `X-RateLimit-*` headers are those of the top-most `@RateLimit`: decorators apply bottom-up, so the one nearest the method runs first and the top-most one last.
- `RateLimitMiddleware` is registered as `RouteMiddleware`: `http.routes.middlewares: [{ service: 'RateLimitMiddleware', options: [600, 60] }]` gives every route its own counter of 600 requests a minute per address. A route that declares its own `@RateLimit` (on the route or its controller) drops this global entry: a middleware type is mounted once per route, and the route's declaration wins, so the floor and the route's limit do not stack. A route that must never be limited, not even by the floor, declares `@RateLimit({ config: false })`. With `MemoryThrottleStore` a floor keeps one key per route and client network (swept every 10,000 increments); with a shared store it adds one store round trip to every route.

### The options form: configured limits, `answer`, `headers`, `key`

`@RateLimit(options)` takes an `IRateLimitOptions` object. A library route uses it to ship a limit the app can change or turn off, and to keep the throttled answer the route already documents.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `config` | `string` or `false` | none | `false` alone (`@RateLimit({ config: false })`, no other option): the route is declared unlimited in code. Nothing is mounted, the global floor is dropped, and a `@RateLimit` of the controller is off on that route. A string: the configuration key read once, when the route is mounted. Its value is `{ limit?, windowSeconds?, by?, headers? }`, merged over `default`, or `false`: the middleware is not mounted on the route at all, so the route has no `RateLimitMiddleware` limit, not even a global `http.routes.middlewares` floor. An unset key uses `default`. `{ limit: 0 }` is not "unlimited": it closes the route. |
| `default` | `IRateLimitSettings` | required with `config` | `{ limit, windowSeconds, by?, headers? }` used when the key is not set (or when there is no `config`). |
| `limit`, `windowSeconds`, `by` | as in the positional form | | Inline settings, without `config`. Combined with `config` they are refused. |
| `answer` | `(retryAfterSeconds: number) => Response` | the 429 above | The throttled answer. It sets its own headers, such as `Retry-After`. A closed route (`limit: 0`) passes `windowSeconds`. |
| `headers` | `boolean` | `false` | `true`: `X-RateLimit-*` headers on every counted response, and a `Retry-After` set by the middleware next to an `answer`. Off: no `X-RateLimit-*`; without an `answer`, the 429 over the limit carries `Retry-After` itself, a closed route's 429 has none; an `answer` decides. A `headers` in the configured value (or in `default`) wins over this option. `false` also keeps `headers` out of the keys the configured value and `default` may set, so the app cannot turn the headers on. |
| `key` | `(ctx: IMiddlewareContext) => string \| undefined` | none | A counting key of its own per request, such as a session handle; `undefined` or `''` counts by `by`. It is stored as `key:<value>` under the route's key, so it never shares a counter with an address or a principal. |

A `key` limits per value, so it is only as strong as the value is hard to vary. A key read straight from the request (a header, a cookie, a body field) is chosen by the client: a new value per request gets a new counter, and the `by` fallback never applies. Derive it from state the server validated (a session it found, a pending sign-in it looked up), and keep an address limit on the same route, a second `@RateLimit` or an `http.throttle` rule, for the requests that never reach that state. The value is written to the store in clear: hash secrets, with an HMAC keyed by a server secret for low-entropy values such as login names or emails, which a bare SHA-256 does not hide.

```ts sample
import { createHmac } from 'node:crypto';
import { BaseController, BasePath, Ok, Post, RateLimit, RawJsonResponse } from '@spinajs/http';

// The route's own throttled answer: the same 401 as any other failed sign-in.
const throttledSignIn = (retryAfterSeconds: number) =>
  new RawJsonResponse(401, { error: { code: 'E_SIGN_IN_FAILED' } }, { Headers: [{ Name: 'Retry-After', Value: String(retryAfterSeconds) }] });

const KEY_SECRET = process.env.RATE_LIMIT_KEY_SECRET ?? '';

@BasePath('sign-in')
export class SignInController extends BaseController {
  @Post()
  @RateLimit({
    config: 'app.rateLimit.signIn',
    default: { limit: 30, windowSeconds: 60 },
    answer: throttledSignIn,
    // X-RateLimit-* would tell a throttled client from a wrong password: the app may not turn them on
    headers: false,
  })
  public password() {
    return new Ok();
  }

  // Per pending sign-in: a server middleware looked it up from the session cookie and put its id in res.locals.
  @Post()
  @RateLimit({
    limit: 5,
    windowSeconds: 300,
    key: ({ res }) => {
      const pending = res.locals.pendingSignInId as string | undefined;
      return pending ? createHmac('sha256', KEY_SECRET).update(pending).digest('hex') : undefined;
    },
  })
  // Per address, for the requests without a pending sign-in.
  @RateLimit(30, 300)
  public code() {
    return new Ok();
  }
}
```

The app then overrides the shipped numbers, or turns the limit off:

```ts
export default {
  app: {
    rateLimit: {
      signIn: { limit: 10 }, // windowSeconds and by from the default
      // signIn: false,      // no limit on the route
      // signIn: { limit: 0 }, // NOT unlimited: refuses every request
    },
  },
};
```

- The numbers are read once, when the route is mounted; a change needs a restart.
- The store key is the same as in the positional form, `rate:<METHOD> <path>:<limit>/<window>:<subject>`: changed numbers start fresh windows.
- `RateLimitMiddleware`'s `limit`, `windowSeconds` and `by` hold the effective settings once the route is mounted.
- In `http.routes.middlewares` the options form is `options: [{ limit: 600, windowSeconds: 60 }]`, with `headers: true` to send the `X-RateLimit-*` headers; `answer` and `key` need code, so they only come from a decorator or a subclass.
- A package that ships configured limits describes each key with `rateLimitSchema(default, route, opts?)` in its configuration schema: `false` or `{ limit?, windowSeconds?, by?, headers? }`, with the default filled and unknown or out-of-range settings refused at boot. For a route declared with `headers: false`, pass `{ headers: false }` as `opts`: the schema then refuses `headers` too, as the middleware does when the route mounts.
- `RateLimitDefault` types a table of shipped defaults: `limit`, `windowSeconds` and `by` required, `headers` optional.

```ts sample
import { BaseController, BasePath, Ok, Post, RateLimit } from '@spinajs/http';

@BasePath('webhooks')
@RateLimit(60, 60)
export class WebhookController extends BaseController {
  // Called by a partner in bursts from a few addresses: never limited, not even by a global floor.
  @Post()
  @RateLimit({ config: false })
  public delivery() {
    return new Ok();
  }
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ThrottleStore` (abstract) | Class `ThrottleStore`, autoinjected into `ThrottleMiddleware` and `RateLimitMiddleware`; singleton | `MemoryThrottleStore` (`@Injectable(ThrottleStore)`) | none shipped | Register your store with `@Injectable(ThrottleStore)` (or `DI.register(Mine).as(ThrottleStore)`) before `HttpServer` resolves; the last registration wins. |
| `ThrottleMiddleware` | `ServerMiddleware` list, Order 3 | `ThrottleMiddleware` | | Subclass and `DI.register(Mine).as(ThrottleMiddleware)` before `HttpServer` resolves; override `onBefore(ctx)`, calling `super.onBefore(ctx)` for the configured rules. |
| `RateLimitMiddleware` | `RouteMiddleware`, `@NewInstance()` (one per route), mounted by `@RateLimit` | `RateLimitMiddleware` | | Subclass and mount it with `@Middleware(Mine, limit, windowSeconds, by)` or `@Middleware(Mine, options)` (an `onRegister` override must call `super.onRegister`, or the route fails its requests closed), or `DI.register(Mine).as(RateLimitMiddleware)` before `Controllers` resolves. |

Members:

| Member | Meaning |
| --- | --- |
| `increment(key, windowSeconds): IThrottleHit \| Promise<IThrottleHit>` | Count one hit and return `{ count, resetAt }`; `count` includes this hit, `resetAt` is epoch milliseconds. |

### `ThrottleStore`: custom implementation

Behind a load balancer, memory counters are per instance: the effective limit is `limit × instances`. Share them through Redis (or any store with an atomic increment and expiry). The sketch uses a minimal client interface so it works with `ioredis` or `node-redis`:

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { IThrottleHit, ThrottleStore } from '@spinajs/http';

/** The two commands the store needs; ioredis and node-redis both provide them. */
export interface IRedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
}

@Injectable(ThrottleStore)
export class RedisThrottleStore extends ThrottleStore {
  protected Redis: IRedisLike;

  constructor() {
    super();
    this.Redis = DI.resolve('throttle-redis') as unknown as IRedisLike;
  }

  public async increment(key: string, windowSeconds: number): Promise<IThrottleHit> {
    const redisKey = `throttle:${key}`;
    const count = await this.Redis.incr(redisKey);

    if (count === 1) {
      // First hit opens the window.
      await this.Redis.pexpire(redisKey, windowSeconds * 1000);
    }

    const ttl = await this.Redis.pttl(redisKey);
    return { count, resetAt: Date.now() + Math.max(ttl, 0) };
  }
}

// Register the client under the name the store reads, before HttpServer resolves:
// DI.register(() => new Redis(process.env.REDIS_URL)).as('throttle-redis');
```

## Important behaviour

- `ThrottleMiddleware` is off by default; enabling it with no rules logs a warning and does nothing. `@RateLimit` needs no configuration.
- The first matching rule wins: a broad rule listed first shadows the specific ones after it.
- Path matching is case-insensitive and on segment boundaries: `/auth` covers `/auth/login` but not `/authority`.
- The path includes `http.controllers.route.prefix`; write it in the rule.
- Counting is per client address, the one `RealIp` resolves for authn too. Set [`http.trustProxy`](17-client-ip-and-trust-proxy.md) behind a proxy, or every client shares the proxy's counter.
- `MemoryThrottleStore` limits per process; with N instances the effective limit is N × `limit`.
- A failing store answers the request with the store's error (500), it does not let the request through.
- `limit: 0` refuses every matching request.
- `X-RateLimit-*` headers are opt-in, for `http.throttle` rules and `@RateLimit` alike: set `headers: true`.

## Best practices

- Throttle the unauthenticated surface (login, password reset, sign-up) with low limits and long windows.
- Prefer `@RateLimit` for a limit that belongs to one route: it follows the route when `@BasePath` or `http.controllers.route.prefix` moves it, where a path rule would stop matching.
- Count by `'principal'` on authenticated, expensive routes, so clients behind one NAT do not share a limit.
- Put specific rules before broad ones.
- Use a shared store whenever more than one instance serves traffic.

## Patterns and antipatterns

```ts
// Don't: the broad rule matches first; the password rule never applies.
rules: [
  { path: '/auth', limit: 10, windowSeconds: 60 },
  { path: '/auth/password', limit: 5, windowSeconds: 300 },
]

// Do
rules: [
  { path: '/auth/password', limit: 5, windowSeconds: 300 },
  { path: '/auth', limit: 10, windowSeconds: 60 },
]
```

## Examples

### Check the fixed window in a unit test

```ts sample
import { MemoryThrottleStore } from '@spinajs/http';

const store = new MemoryThrottleStore();
const key = '203.0.113.7:/auth:POST';

const first = store.increment(key, 60);
const second = store.increment(key, 60);

console.log(first.count, second.count); // 1 2
console.log(second.resetAt === first.resetAt); // true: one window, opened by the first hit
```

## Related

- [Client IP and trusted proxies](17-client-ip-and-trust-proxy.md): the address the counters use.
- [Server middlewares](15-server-middlewares.md): `Order` and replacement.
- [`@spinajs/authn`](../authn/README.md): per-account login throttling.
- [Validator options](../validation/02-validator-options.md#strict-schema-ids): the strict, non-coercing validation of the `@RateLimit` options.
