# Client IP and trusted proxies

`RealIp` writes the client address into `req.storage.realIp` on every request. Behind a load balancer or reverse proxy it reads `X-Forwarded-For`, but only through the proxies you trust in `http.trustProxy`; with no trust configured it uses the socket address. `@Ip()`, the access log, the throttle and `@spinajs/authn-http` all read this value. The same trust rules are exported as functions for other packages.

## How it works

At startup, `RealIp.before()` (Order 1) parses `http.trustProxy` with `parseTrustProxy(value, 'http.trustProxy')`. A bad value throws `InvalidOption` and stops the boot.

Per request, `trustedClientAddress(socketAddress, xForwardedFor, trust)`:

1. Starts from the socket address (IPv4-mapped IPv6 such as `::ffff:10.0.0.5` becomes `10.0.0.5`). No socket address: `undefined`.
2. Walks the `X-Forwarded-For` entries from right to left. It steps to the next entry only while the current address is trusted:
   - hop count `n`: for the first `n` steps;
   - address list: while the current address is in the list.
3. Stops at the first entry that is not an IP address.
4. The result is always an IP address.

`requestOrigin(req, trust)` returns the app's origin as the client sees it: `X-Forwarded-Proto` and `X-Forwarded-Host` (first value) count only when the socket peer is trusted.

Express's own `trust proxy` setting and `req.ip` are not used.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.trustProxy` | `number \| string \| string[] \| boolean \| null` | `null` | hop count ≥ 0; addresses and CIDRs (`10.0.0.0/8`, `::1`) and the names `loopback`, `linklocal`, `uniquelocal`, as an array or a comma-separated string; `true` = one hop; `false`, `0`, `null` = none | Which proxies' `X-Forwarded-For` counts. |

| Name | Ranges |
| --- | --- |
| `loopback` | `127.0.0.0/8`, `::1/128` |
| `linklocal` | `169.254.0.0/16`, `fe80::/10` |
| `uniquelocal` | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7` |

```ts
export default {
  http: {
    // Two layers: the cloud load balancer and the ingress controller, both in private ranges.
    trustProxy: ['uniquelocal'],
  },
};
```

`true` means one hop, never "trust everything". The schema refuses a string that is only a number (`"1"`): write the number.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `RealIp` | `ServerMiddleware` list, Order 1, singleton | `RealIp` | `ClientIp` in `@spinajs/authn-http` (reads `authn.http.trustProxy`, falls back to `http.trustProxy`) | Subclass and `DI.register(Mine).as(RealIp)` before `HttpServer` resolves. |
| `parseTrustProxy(value, key)` | exported function | | | Returns a `ProxyTrust`: `{ hops }` or `{ list: BlockList }`. Throws `InvalidOption` naming `key`. |
| `trustedClientAddress(socket, xff, trust)` | exported function | | | The walk described above. |
| `isTrustedPeer(trust, peer)` | exported function | | | Whether the immediate peer is a trusted proxy. |
| `requestOrigin(req, trust)` | exported function | | | `http(s)://host` as the client sees it. |

### `RealIp`: custom implementation

Some CDNs put the client address in their own header, set only by the CDN edge. Prefer that header when the request comes through a trusted proxy, and fall back to the standard walk otherwise:

```ts sample
import { DI } from '@spinajs/di';
import { RealIp, Request, isTrustedPeer, parseTrustProxy, trustedClientAddress } from '@spinajs/http';
import * as express from 'express';
import { isIP } from 'node:net';

export class CdnRealIp extends RealIp {
  public before() {
    const trust = parseTrustProxy(this.TrustProxy, 'http.trustProxy');

    return (req: Request, _res: express.Response, next: express.NextFunction) => {
      const cdnHeader = req.headers['cf-connecting-ip'];
      const viaTrustedProxy = isTrustedPeer(trust, req.socket?.remoteAddress);

      req.storage.realIp =
        viaTrustedProxy && typeof cdnHeader === 'string' && isIP(cdnHeader) !== 0
          ? cdnHeader
          : trustedClientAddress(req.socket?.remoteAddress, req.headers['x-forwarded-for'], trust);
      next();
    };
  }
}

DI.register(CdnRealIp).as(RealIp);
```

## Important behaviour

- Without `http.trustProxy`, behind a proxy every request shows the proxy's address: rate limits and logs then treat all clients as one.
- Trusting too much lets clients forge their address: with `trustProxy: 2` and only one real proxy, a client-sent `X-Forwarded-For` entry is believed.
- A hop count trusts any peer for that many steps; an address list trusts only listed peers. Prefer a list when proxy addresses are known.
- A non-IP entry in `X-Forwarded-For` (eg. `unknown`) stops the walk at the last good address.
- `requestOrigin()` takes only the first `X-Forwarded-Proto` and `X-Forwarded-Host` value; the trusted proxy must overwrite both headers, not append to them.

## Best practices

- Set `http.trustProxy` to the address ranges of your proxies, eg. `['uniquelocal']` inside a private network.
- Read the client address with `@Ip()` or `req.storage.realIp`, never `req.ip` or `X-Forwarded-For` directly.
- Reuse `parseTrustProxy` and `trustedClientAddress` in other packages so every component agrees on the client address.

## Patterns and antipatterns

```ts
// Don't: the first X-Forwarded-For entry is whatever the client sent.
const ip = String(req.headers['x-forwarded-for']).split(',')[0];

// Do
const ip = (req as Request).storage.realIp;
```

## Examples

### Resolve the client address in a script or a test

```ts sample
import { parseTrustProxy, requestOrigin, trustedClientAddress } from '@spinajs/http';

const trust = parseTrustProxy(['10.0.0.0/8'], 'http.trustProxy');

// Client 203.0.113.7 → proxy 10.0.0.2 → app; the client also sent a forged entry.
console.log(trustedClientAddress('10.0.0.2', '198.51.100.1, 203.0.113.7', trust)); // 203.0.113.7

console.log(
  requestOrigin({ headers: { host: 'internal:8080', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'shop.example.com' }, socket: { remoteAddress: '10.0.0.2' } }, trust),
); // https://shop.example.com
```

## Related

- [Route arguments](04-route-arguments.md): `@Ip()`.
- [Throttling](18-throttling.md): counts per client address.
- [Request storage and tracing](19-request-storage-and-tracing.md): `req.storage` and the access log.
- `@spinajs/authn-http`: `ClientIp` and the CSRF origin check built on these functions.
