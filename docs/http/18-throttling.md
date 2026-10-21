# Throttling

`ThrottleMiddleware` caps how many requests one client address may send to a path in a fixed time window, before any route code runs. Rules match by path prefix and HTTP method; a request over the limit gets 429 with `Retry-After`. Counters live in a `ThrottleStore`: in process memory by default, or in a shared store you provide for several instances.

It is off by default. It does **not** replace the login throttle of `@spinajs/authn`, which limits per account and per IP on the login flow itself.

## How it works

At startup (`ThrottleMiddleware.before()`, Order 3, after `RealIp`):

1. Reads `http.throttle`. Not enabled: no handler.
2. Checks every rule: `limit` must be a finite number ≥ 0 and `windowSeconds` a finite number > 0, else `InvalidOption` stops the boot.
3. No rules: logs a warning and adds no handler.

Per request:

1. Finds the **first** rule whose `path` is a prefix of `req.path` on a segment boundary (case-insensitive) and whose `methods` include the request method (or that has no `methods`). No rule: `next()`.
2. Builds the key `<ip>:<rule.path>:<methods or *>`. The address is `req.storage.realIp`, else the socket address. An IPv6 address is replaced by its network, `<network>/<prefix>` with `http.throttle.ipv6Prefix`, so a client that owns a whole /64 cannot get a fresh window per address. IPv4 and IPv4-mapped addresses are keyed whole.
3. Calls `ThrottleStore.increment(key, windowSeconds)`.
4. Sets `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (Unix seconds).
5. Over the limit: sets `Retry-After` (seconds, at least 1) and answers 429 with `{ error: { code: 'E_TOO_MANY_REQUESTS', message: 'Too many requests, try again later' } }`.
6. A store that throws: the error goes to `next(err)` and the error handler answers it.

`MemoryThrottleStore` keeps fixed windows in a `Map`. A window starts at the first hit and resets after `windowSeconds`. Expired keys are dropped on their next hit and in a full sweep every 10,000 increments (`MemoryThrottleStore.SWEEP_INTERVAL`).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.throttle.enabled` | `boolean` | `false` | | Turns the middleware on. |
| `http.throttle.ipv6Prefix` | `integer` | `64` | 16 to 128 | IPv6 clients are counted per prefix of this many bits. |
| `http.throttle.rules` | `IThrottleRule[]` | `[]` | | Checked in order; the first match wins. |
| `http.throttle.rules[].path` | `string` | required | non-empty path prefix | Matched against the request path, including `http.controllers.route.prefix`. |
| `http.throttle.rules[].methods` | `string[]` | all methods | HTTP methods | Methods the rule applies to. |
| `http.throttle.rules[].limit` | `integer` | required | ≥ 1 in the schema; 0 refuses every request | Requests allowed per window per address. |
| `http.throttle.rules[].windowSeconds` | `integer` | required | ≥ 1 | Window length. |

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

The counters are per process unless you register a shared `ThrottleStore`. Behind a proxy set `http.trustProxy`, or every client shares the proxy's address.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ThrottleStore` (abstract) | Class `ThrottleStore`, autoinjected into `ThrottleMiddleware`; singleton | `MemoryThrottleStore` (`@Injectable(ThrottleStore)`) | none shipped | Register your store with `@Injectable(ThrottleStore)` (or `DI.register(Mine).as(ThrottleStore)`) before `HttpServer` resolves; the last registration wins. |
| `ThrottleMiddleware` | `ServerMiddleware` list, Order 3 | `ThrottleMiddleware` | | Subclass and `DI.register(Mine).as(ThrottleMiddleware)` before `HttpServer` resolves; override `before()`. |

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

- Off by default; enabling it with no rules logs a warning and does nothing.
- The first matching rule wins: a broad rule listed first shadows the specific ones after it.
- Path matching is case-insensitive and on segment boundaries: `/auth` covers `/auth/login` but not `/authority`.
- The path includes `http.controllers.route.prefix`; write it in the rule.
- Counting is per client address. Set [`http.trustProxy`](17-client-ip-and-trust-proxy.md) behind a proxy, or every client shares the proxy's counter.
- `MemoryThrottleStore` limits per process; with N instances the effective limit is N × `limit`.
- A failing store answers the request with the store's error (500), it does not let the request through.
- `limit: 0` refuses every matching request.

## Best practices

- Throttle the unauthenticated surface (login, password reset, sign-up) with low limits and long windows.
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
