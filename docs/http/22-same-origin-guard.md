# Same-origin guard

`checkSameOrigin()` decides whether a request comes from the app's own origin, from the `Origin` and `Sec-Fetch-Site` headers. `SameOriginGuard` is a server middleware built on it that answers 403 to cross-origin state-changing requests. Browsers send cookies with cross-site requests, so this check is the CSRF defence for cookie-authenticated routes. The guard is not registered by default: subclass it, choose which requests it checks, and register the subclass.

## How it works

`checkSameOrigin(headers, ownOrigin, { allowedOrigins, missingOrigin })` returns `{ allowed: true }` or `{ allowed: false, reason }`:

1. With an `Origin` header:
   - not a serialized origin (`null`, `*`, a path, credentials): refused, `malformed-origin`;
   - equal to `ownOrigin` or to an entry of `allowedOrigins`, compared as normalised origins (case and default port do not matter): allowed;
   - anything else: refused, `foreign-origin`.
   `Sec-Fetch-Site` is not read in this case.
2. Without an `Origin` header:
   - `Sec-Fetch-Site: same-origin`: allowed;
   - `Sec-Fetch-Site: cross-site` or `same-site`: refused, `cross-site-fetch` (a sibling subdomain is another origin);
   - otherwise (no header, or `none`) by `missingOrigin`: `same-origin-fetch` (the default) refuses with `missing-origin`, `unless-cross-site` allows. Servers and older browsers send neither header.

`ownOrigin` is normally `requestOrigin(req, requestProxyTrust(req))`: the scheme and host the client sees, through `X-Forwarded-Proto` and `X-Forwarded-Host` only from a trusted proxy. When it is `undefined` or not an origin (no `Host`), only allowed origins pass.

`SameOriginGuard` (Order 2, after `RealIp`):

1. At startup, reads `allowedOrigins()` once.
2. Per request, calls `next()` when `appliesTo(req)` is false (by default for `GET`, `HEAD` and `OPTIONS`).
3. Otherwise runs `checkSameOrigin()` with the own origin from `requestOrigin()` and the trust `RealIp` stored, and calls `next()` when allowed.
4. When refused, calls `refuse(reason, req, res, next)`: by default `403` with `{ "error": { "code": "E_ORIGIN_REFUSED", "message": "Cross-origin request refused" } }`.

## Configuration

The guard has no configuration keys of its own. A subclass reads its allowed origins from its own key and passes them through `parseAllowedOrigins(entries, key)`, which normalises them and throws `InvalidOption` naming `key` for an entry that is not `scheme://host[:port]`. The own origin depends on `http.trustProxy` (see [Client IP and trusted proxies](17-client-ip-and-trust-proxy.md)).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SameOriginGuard` | abstract `ServerMiddleware`, not registered | | | Subclass, decorate with `@Injectable(ServerMiddleware)`. Override `appliesTo(req)`, `allowedOrigins()`, `refuse(reason, req, res, next)`, set `MissingOrigin` or `Order`. |
| `checkSameOrigin(headers, ownOrigin, options)` | exported function | | | The decision above, for code that is not an Express middleware (a socket handshake, a controller). |
| `parseAllowedOrigins(entries, key)` | exported function | | | A normalised `ReadonlySet<string>` for `allowedOrigins`. |
| `OriginRefusal`, `OriginDecision`, `MissingOriginRule` | exported types | | | |

## Important behaviour

- Without a trusted proxy setting, behind a TLS-terminating proxy the own origin is `http://internal-host`: every browser request then fails with `foreign-origin`. Set `http.trustProxy`, or list the public origin as allowed.
- `RealIp` must run first; without `req.storage.proxyTrust` no proxy is trusted.
- The guard checks every unsafe request by default, login and token requests included. A guard meant for cookie sessions narrows `appliesTo` to requests that carry the session cookie, so API clients with bearer tokens are not refused.
- `same-origin-fetch` refuses clients that send neither `Origin` nor `Sec-Fetch-Site`. Choose `unless-cross-site` where such clients must pass.

## Examples

### A guard for cookie-authenticated requests

```ts sample
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Request, SameOriginGuard, ServerMiddleware, parseAllowedOrigins } from '@spinajs/http';

@Injectable(ServerMiddleware)
export class SessionCsrfGuard extends SameOriginGuard {
  @Config('app.csrf.allowedOrigins')
  protected AllowedOrigins: string[];

  protected appliesTo(req: Request) {
    return super.appliesTo(req) && (req.headers.cookie ?? '').split(';').some((pair) => pair.split('=')[0].trim() === 'sid');
  }

  protected allowedOrigins() {
    return parseAllowedOrigins(this.AllowedOrigins, 'app.csrf.allowedOrigins');
  }
}
```

### Check a request outside a middleware

```ts sample
import { checkSameOrigin, parseTrustProxy, requestOrigin } from '@spinajs/http';

const headers = { host: 'app.example.com', origin: 'https://evil.example.net' };
const own = requestOrigin({ headers, socket: { encrypted: true } }, parseTrustProxy(null, 'http.trustProxy'));

console.log(checkSameOrigin(headers, own)); // { allowed: false, reason: 'foreign-origin' }
console.log(checkSameOrigin({ 'sec-fetch-site': 'none' }, own, { missingOrigin: 'unless-cross-site' })); // { allowed: true }
```

## Related

- [Client IP and trusted proxies](17-client-ip-and-trust-proxy.md): `requestOrigin`, `requestProxyTrust`, `http.trustProxy`.
- [CORS](16-cors.md): which origins may read answers; `parseOrigin`.
- [Server middlewares](15-server-middlewares.md): `Order` and registering a middleware.
