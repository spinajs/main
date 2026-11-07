# CORS

`CorsMiddleware` sends CORS headers to browser requests from the origins you list in `http.cors.origins`, and answers their preflight requests. Requests from other origins proceed without CORS headers, so the browser refuses to share the answer. A route marked `@Cors({ origins })` uses its own origins instead. With no origins configured and no `@Cors` route, no CORS headers are sent at all and browsers allow same-origin requests only.

## How it works

When the middleware resolves (Order -1, before every shipped server middleware but those you place lower):

1. Reads `http.cors`. Absent, `null`, `false` or `true`: no global origins.
2. Normalizes every entry of `origins` except `'*'` with `parseOrigin()`: lower-case scheme and host, default port removed, trailing slash removed. An entry that is not `scheme://host[:port]` throws `InvalidOption` and stops the boot.
3. With no origin and no `'*'`, it logs a warning; only `@Cors` routes then get CORS headers. The middleware is always mounted.

Per request (`onBefore`):

1. Picks the policy: the `@Cors` one of the route the request goes to (`ctx.route`, matched [before routing](15-server-middlewares.md#the-route-before-routing)); for a preflight, of the route that serves the method in `Access-Control-Request-Method` on that path; else `http.cors.origins`.
2. When the policy lists explicit origins, adds `Vary: Origin`.
3. Asks `allowance(origin)` what the request's `Origin` gets (a `@Cors` route: its own origins). Without an `Origin` header, or with an origin that is neither listed nor covered by `'*'`: the request goes on with no CORS header.
4. Listed origin: `Access-Control-Allow-Origin: <origin>` and `Access-Control-Allow-Credentials: true` (not with `@Cors({ credentials: false })`). Unlisted origin under `'*'`: `Access-Control-Allow-Origin: *`, no credentials.
5. **Preflight** (`OPTIONS` with `Access-Control-Request-Method`): adds `Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE`, `Access-Control-Allow-Headers` (the configured `allowedHeaders`, or the requested headers echoed with `Vary: Access-Control-Request-Headers`) and the route's `Access-Control-Max-Age` when its `@Cors` sets `maxAge`, then answers 204 with an empty body. The answer goes through the reply pipeline: server middlewares entered before CORS (a lower `Order`) see it in `onAfter`.
6. Other requests: adds `Access-Control-Expose-Headers` when `exposedHeaders` is set, and the request goes on.

`Forwarded` and every `X-Forwarded-*` header are removed from the allowed headers, configured or echoed: a page on an allowed origin must not choose what the app believes a trusted proxy said. An echoed entry that is not an RFC 9110 header name (a space, `<`, a non-ASCII byte) is dropped too.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.cors` | `object \| boolean \| null` | not set | object, `null`, `true`, `false` | Absent or not an object: CORS headers on `@Cors` routes only. |
| `http.cors.origins` | `string[] \| null` | not set | `scheme://host[:port]` entries and `'*'` | Origins that get CORS headers. Compared exactly with the browser's `Origin`. |
| `http.cors.exposedHeaders` | `string[] \| string \| null` | not set | header names | `Access-Control-Expose-Headers` for allowed origins. |
| `http.cors.allowedHeaders` | `string[] \| string \| null` | not set | header names | `Access-Control-Allow-Headers` for preflights; without it the requested headers are echoed. |

The `http.configuration` schema validates `origins` entries with the same origin pattern, so a bad entry fails configuration loading too.

```ts
export default {
  http: {
    cors: {
      origins: ['https://app.example.com', 'http://localhost:5173'],
      exposedHeaders: ['x-request-id', 'Retry-After'],
      allowedHeaders: ['content-type', 'authorization', 'x-tenant-id'],
    },
  },
};
```

## Per-route policy: `@Cors`

`@Cors({ origins, credentials?, maxAge? })` on an action, or on a controller for all its actions (an action's own wins), replaces `http.cors.origins` for that route, also when `http.cors` is not set. `exposedHeaders` and `allowedHeaders` still come from `http.cors`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `origins` | `string[]` | required | `scheme://host[:port]` entries and `'*'`, as in `http.cors.origins`. Empty: the route answers no origin, even one `http.cors.origins` lists. |
| `credentials` | `boolean` | `true` | `false`: a listed origin is echoed without `Access-Control-Allow-Credentials`. |
| `maxAge` | `number` | not sent | Seconds, a whole number: `Access-Control-Max-Age` on the route's preflight answer. |

A bad entry or `maxAge` throws `InvalidOption` when the controller class is declared.

```ts sample
import { BaseController, BasePath, Cors, Get, Ok, Post } from '@spinajs/http';

@BasePath('widgets')
export class WidgetController extends BaseController {
  // Embedded on partner sites: any origin, no cookies.
  @Cors({ origins: ['*'] })
  @Get()
  public list() {
    return new Ok([]);
  }

  // Only the shop front-end may post, and its preflight is cached for 10 minutes.
  @Cors({ origins: ['https://shop.example.com'], maxAge: 600 })
  @Post()
  public order() {
    return new Ok({ ordered: true });
  }
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `CorsMiddleware` | `ServerMiddleware` list, Order -1, singleton | `CorsMiddleware` | none shipped | Subclass and `DI.register(Mine).as(CorsMiddleware)` before `HttpServer` resolves; override `allowance(origin)`, which returns `{ allowOrigin, credentials }` or `undefined` for routes without `@Cors`; an overridden `allowance()` always sends `Vary: Origin` there. Or replace it with your own `ServerMiddleware`. |
| `parseOrigin(value)` | exported function | | | Returns the normalized origin, or `undefined` for anything that is not an origin. Reuse it to compare origins the same way. |

### `CorsMiddleware`: custom implementation

Allow every subdomain of your domain over HTTPS, a rule an exact list cannot express. The subclass only changes the decision; `Vary`, the preflight answer and the exposed headers stay the default's. With it the apex domain can stay out of `http.cors.origins`, or be listed there:

```ts sample
import { DI } from '@spinajs/di';
import { CorsAllowance, CorsMiddleware, parseOrigin } from '@spinajs/http';

const ALLOWED = /^https:\/\/([a-z0-9-]+\.)*example\.com$/;

export class SubdomainCors extends CorsMiddleware {
  protected allowance(origin: string): CorsAllowance | undefined {
    // Browsers send the serialized origin; anything else is not an origin a rule should match.
    if (parseOrigin(origin) === origin && ALLOWED.test(origin)) {
      return { allowOrigin: origin, credentials: true };
    }
    return super.allowance(origin);
  }
}

// with http.cors.origins: ['https://example.com']
DI.register(SubdomainCors).as(CorsMiddleware);
```

## Important behaviour

- No origins, no CORS. An empty, `null` or missing `origins` list sends no CORS headers; it does not reflect every origin.
- Origins are compared as serialized origins: `https://App.Example.com:443/` in configuration matches the browser's `https://app.example.com`.
- `'*'` never comes with credentials. An origin listed explicitly next to `'*'` still gets its echo with credentials.
- A preflight from a disallowed origin is not answered by this middleware; it continues to routing and usually ends in 404.
- `Access-Control-Max-Age` is sent only for a `@Cors({ maxAge })` route; elsewhere browsers repeat the preflight with their default cache time.
- A `@Cors` route is found by the [pre-routing match](15-server-middlewares.md#the-route-before-routing): a static file or an `http.middlewares` handler answering the same path first gets the global policy.
- CORS is not access control: a non-browser client ignores it. Protect routes with [policies](13-policies.md).

## Best practices

- List each front-end origin explicitly, including the port in development.
- Set `allowedHeaders` instead of echoing; it documents what the API accepts.
- Expose `x-request-id` so browser clients can report it with errors.

## Patterns and antipatterns

```ts
// Don't: '*' with cookie sessions — browsers drop credentials for '*', so logins silently fail.
cors: { origins: ['*'] }

// Do: list the front-end origins that send cookies.
cors: { origins: ['https://app.example.com'] }
```

## Examples

### Normalize an origin from configuration

```ts sample
import { parseOrigin } from '@spinajs/http';

console.log(parseOrigin('HTTPS://Shop.Example.com:443/')); // https://shop.example.com
console.log(parseOrigin('https://example.com/path')); // undefined: has a path
console.log(parseOrigin('https://*.example.com')); // undefined: wildcard host
```

## Related

- [Server middlewares](15-server-middlewares.md): `Order` and replacement.
- [Client IP and trusted proxies](17-client-ip-and-trust-proxy.md): why `X-Forwarded-*` is never an allowed header.
- [CSRF guard](23-csrf-guard.md): compares `Origin` with the app's own origin; a CORS origin is not allowed there unless it is also in `http.csrf.allowedOrigins`.
