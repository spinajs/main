# CORS

`CorsMiddleware` sends CORS headers to browser requests from the origins you list in `http.cors.origins`, and answers their preflight requests. Requests from other origins proceed without CORS headers, so the browser refuses to share the answer. With no origins configured, no CORS headers are sent at all and browsers allow same-origin requests only.

## How it works

At startup (`CorsMiddleware.before()`, Order -1, right after the request storage):

1. Reads `http.cors`. Absent, `null`, `false` or `true`: no handler.
2. Normalizes every entry of `origins` except `'*'` with `parseOrigin()`: lower-case scheme and host, default port removed, trailing slash removed. An entry that is not `scheme://host[:port]` throws `InvalidOption` and stops the boot.
3. With no origin and no `'*'`, it logs a warning and adds no handler.

Per request:

1. When explicit origins are listed, adds `Vary: Origin`.
2. Without an `Origin` header, or with an origin that is neither listed nor covered by `'*'`: calls `next()` with no CORS header.
3. Listed origin: `Access-Control-Allow-Origin: <origin>` and `Access-Control-Allow-Credentials: true`. Unlisted origin under `'*'`: `Access-Control-Allow-Origin: *`, no credentials.
4. **Preflight** (`OPTIONS` with `Access-Control-Request-Method`): adds `Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE` and `Access-Control-Allow-Headers` (the configured `allowedHeaders`, or the requested headers echoed with `Vary: Access-Control-Request-Headers`), then answers 204 with an empty body.
5. Other requests: adds `Access-Control-Expose-Headers` when `exposedHeaders` is set, then `next()`.

`Forwarded` and every `X-Forwarded-*` header are removed from the allowed headers, configured or echoed: a page on an allowed origin must not choose what the app believes a trusted proxy said. An echoed entry that is not an RFC 9110 header name (a space, `<`, a non-ASCII byte) is dropped too.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.cors` | `object \| boolean \| null` | not set | object, `null`, `true`, `false` | Absent or not an object: no CORS middleware. |
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

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `CorsMiddleware` | `ServerMiddleware` list, Order -1, singleton | `CorsMiddleware` | none shipped | Subclass and `DI.register(Mine).as(CorsMiddleware)` before `HttpServer` resolves; override `before()`. Or turn it off (no `http.cors`) and add your own `ServerMiddleware`. |
| `parseOrigin(value)` | exported function | | | Returns the normalized origin, or `undefined` for anything that is not an origin. Reuse it to compare origins the same way. |

### `CorsMiddleware`: custom implementation

Allow every subdomain of your domain over HTTPS, a rule an exact list cannot express. The subclass decides per request and keeps the preflight answer of the default:

```ts sample
import { DI } from '@spinajs/di';
import { CorsMiddleware, Request, parseOrigin } from '@spinajs/http';
import * as express from 'express';

const ALLOWED = /^https:\/\/([a-z0-9-]+\.)*example\.com$/;

export class SubdomainCors extends CorsMiddleware {
  public before() {
    return (req: Request, res: express.Response, next: express.NextFunction) => {
      res.vary('Origin');

      const origin = parseOrigin(req.headers.origin);
      if (!origin || !ALLOWED.test(origin)) {
        return next();
      }

      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');

      if (req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined) {
        res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
        return;
      }
      next();
    };
  }
}

DI.register(SubdomainCors).as(CorsMiddleware);
```

## Important behaviour

- No origins, no CORS. An empty, `null` or missing `origins` list sends no CORS headers; it does not reflect every origin.
- Origins are compared as serialized origins: `https://App.Example.com:443/` in configuration matches the browser's `https://app.example.com`.
- `'*'` never comes with credentials. An origin listed explicitly next to `'*'` still gets its echo with credentials.
- A preflight from a disallowed origin is not answered by this middleware; it continues to routing and usually ends in 404.
- No `Access-Control-Max-Age` is sent: browsers repeat the preflight with their default cache time.
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
