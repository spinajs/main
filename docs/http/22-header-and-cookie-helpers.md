# Header and cookie helpers

Small, dependency-free functions for code that reads request headers or builds cookies and headers by hand: middlewares, credential extractors, outgoing HTTP clients. They do not touch DI or the configuration.

## Request headers

| Function | Returns |
| --- | --- |
| `parseBearer(header)` | The token of `Authorization: Bearer <token>`, or `null`. The scheme matches in any case, followed by one or more spaces; the token must be an RFC 6750 `b64token` (`A-Z a-z 0-9 - . _ ~ + /`, then optional `=`). Surrounding whitespace is trimmed. An array, a malformed value or a repeated header joined with `, ` gives `null`. |
| `normalizeHeaders(req)` | Lower-cased headers built from `req.rawHeaders`, with a repeated header joined with `, `, in an object without a prototype. Node's `req.headers` keeps only the first of a repeated `Authorization`; read it from here, or check it with `repeatedHeader`, so a second credential is seen and refused. |
| `parseCookieHeader(header)` | The cookies of a `Cookie` header as a prototype-less `name → value` map. Pairs without `=` (cookie-parser skips them too) or with an empty name are skipped, the first of a repeated name wins, surrounding quotes are dropped, and the value is URI-decoded (kept raw when the escape is malformed). |
| `strictHeader(req, name, { maxLength, pattern? })` | The value of header `name` (any case) when the client sent it exactly once, it is at most `maxLength` long and, with `pattern`, the pattern matches all of it. `undefined` otherwise: absent, an array, repeated, too long or not matching. See [Reading an untrusted header](#reading-an-untrusted-header). |
| `strictHeaderReader(name, { maxLength, pattern? })` | `strictHeader` for one header: it checks `maxLength` and `pattern` once, when called (a bad option throws `TypeError` at startup, not on the first request), and returns `(req) => string | undefined`. `@Header()` with `once`, `maxLength` or `pattern` uses it (see [Route arguments](04-route-arguments.md)). |
| `repeatedHeader(req, names)` | The first of `names`, in lower case, that the client sent on more than one line of `req.rawHeaders`, or `undefined`. For singleton fields, whose repeat Node hides by keeping the first copy. |
| `SINGLETON_CREDENTIAL_HEADERS` | `['authorization', 'proxy-authorization']`: the credential fields a client sends once (RFC 9110 §11.6.2, §11.7.2). `@spinajs/authn-http` and `@spinajs/http-socket` refuse a request that repeats one of them, or the `authn.token.headerName` header. |

### Reading an untrusted header

Request headers come from the client. `req.headers` hides two things: Node joins most repeated headers with `, ` and keeps only the first of others (`Authorization`, `Host`, `Content-Type`), and it puts no bound on a value below the 16 KiB of all headers. `strictHeader` reads one header by a grammar you state:

- It counts the header in `req.rawHeaders`, so a repeat is refused whichever way Node folded it. A value your own code put in `req.headers` is read as it is, unless the client sent that header more than once.
- `maxLength` is required. Node decodes header bytes as latin1, so it bounds bytes too.
- `pattern` must start with `^` and end with `$`, and have no `g`, `y` or `m` flag; any other pattern throws `TypeError`. The match must also cover the whole value, so `/^a|b$/` matches neither `xb` nor `ab`: group an alternation, `/^(?:a|b)$/`.
- Keep `pattern` free of nested or overlapping quantifiers (`(a+)+`, `(a|ab)*`, `\s*-?\s*`). `maxLength` bounds the input, not the time a backtracking pattern takes on it.
- It does not trim. Node already drops the spaces and tabs around a value.

```ts sample
import express from 'express';
import { strictHeader } from '@spinajs/http';

const TENANT = /^[a-z0-9-]{1,32}$/;

/** The tenant a gateway put in `X-Tenant`, or a 400 for anything else. */
export function tenantOf(req: express.Request, res: express.Response): string | undefined {
  const tenant = strictHeader(req, 'x-tenant', { maxLength: 32, pattern: TENANT });
  if (tenant === undefined) res.status(400).json({ error: { code: 'E_TENANT', message: 'X-Tenant must be sent once, as a tenant id' } });
  return tenant;
}
```

[Untrusted request headers](25-untrusted-headers.md) lists every request header the framework reads and how it parses each one.

## Outgoing headers

| Function | Returns |
| --- | --- |
| `basicAuthHeader(user, password, { formEncode? })` | `Basic <base64(user:password)>`, UTF-8 (RFC 7617). With `formEncode: true` both parts are form-urlencoded first, as OAuth 2 client authentication requires (RFC 6749 §2.3.1). |
| `retryAfterHeader(seconds)` | `{ Name: 'Retry-After', Value }` for `IResponseOptions.Headers`, rounded up and never below 0. Pass a finite number. `TooManyRequests` uses it (see [Responses](10-responses.md)). |

## Cookies

| Export | Meaning |
| --- | --- |
| `HTTP_PUBLIC_COOKIE_SECRET` | The `http.cookie.secret` the package ships. It is public, so anyone can sign cookies with it. |
| `isPublicCookieSecret(secret)` | `true` when `secret` is that value. Use it to refuse the default outside development and test. |
| `hostPrefixedCookie(name, value, options?, env?)` | An `ICookie` named `__Host-<name>` with `secure: true`, `path: '/'` and `domain: undefined`, which browsers require for the prefix. `domain` is set to `undefined` rather than left out so it overrides a domain from `http.cookie.options`. When `env` is development or test (`dev`, `development`, `test`), the name has no prefix and `secure` is `false`, for plain http on localhost; an absent or other env counts as production. |
| `clearCookie(cookie)` | The same cookie with an empty value, `maxAge: 0` and `signed: false`. Send it to remove a cookie that was set with `cookie`. |

```ts sample
import { BaseController, BasePath, Get, Ok, clearCookie, hostPrefixedCookie } from '@spinajs/http';

const flow = (env?: string) => hostPrefixedCookie('flow', '', { httpOnly: true, sameSite: 'lax', maxAge: 600_000 }, env);

@BasePath('flow')
export class FlowController extends BaseController {
  @Get()
  public start() {
    const cookie = { ...flow(process.env.APP_ENV), Value: 'state-123' };
    return new Ok({ started: true }, { Coockies: [cookie] });
  }

  @Get()
  public end() {
    return new Ok({ ended: true }, { Coockies: [clearCookie(flow(process.env.APP_ENV))] });
  }
}
```

## IP ranges

| Function | Returns |
| --- | --- |
| `parseCidr(value)` | `{ network, prefix, type }` for `10.0.0.0/8`, `2001:db8::/32` or a single address (prefix 32 or 128); `type` is `'ipv4'` or `'ipv6'`. `null` for anything else, for a zone id (`fe80::1%eth0`), and for a network with host bits set (`10.0.0.1/8`), so a typo cannot widen a range. |
| `cidrMatcher(cidrs)` | A function `(ip) => boolean` that is `true` when `ip` lies in one of the ranges, or `null` when any entry fails `parseCidr`. A value that is not an IP address, or carries a zone id, matches nothing. IPv4 and IPv4-mapped IPv6 forms match each other, so `::/0` matches IPv4 addresses too. |

These are stricter than `http.trustProxy` (see [Client IP and trusted proxies](17-client-ip-and-trust-proxy.md)), which accepts host bits and the names `loopback`, `linklocal` and `uniquelocal`.

```ts sample
import { cidrMatcher } from '@spinajs/http';

const office = cidrMatcher(['10.20.0.0/16', '2001:db8:20::/48']);
if (!office) throw new Error('bad office ranges');

office('10.20.3.4'); // true
office('::ffff:10.20.3.4'); // true
office('10.21.0.1'); // false
```

## Related

- [Responses](10-responses.md): `TooManyRequests` and `IResponseOptions`.
- [Cookies](20-cookies.md): how responses set cookies and sign them.
- [Client IP and trusted proxies](17-client-ip-and-trust-proxy.md): `parseTrustProxy` and the client address.
