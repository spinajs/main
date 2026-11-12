# Rate limits

The two anonymous OIDC routes carry a [`@RateLimit`](../http/18-throttling.md#per-route-limits-ratelimit) of
`@spinajs/http`, **on by default**: a fixed-window cap per client address. Back-channel logout is declared unlimited.

| Route | Config key | Default | Throttled answer |
| --- | --- | --- | --- |
| `GET /auth/oidc/:provider` (begin) | `authn.oidc.rateLimit.begin` | 60 / 60 s | the one failure answer, with `Retry-After` |
| `GET /auth/oidc/:provider/callback` | `authn.oidc.rateLimit.callback` | 60 / 60 s | the one failure answer, with `Retry-After` |
| `POST /auth/oidc/:provider/backchannel-logout` | none | **no limit**, not even a global floor | |

The counter is per route, not per provider: every provider's begin shares the begin budget of an address.

## How it works

- The limit runs after the policy gate and before the arguments are read. A refused begin costs no discovery
  lookup; a refused callback costs no token exchange with the IdP.
- A refused client gets the answer of any other OIDC failure (D3), the one a callback throttled by the authn throttle
  already gets: a browser navigation (`Sec-Fetch-Mode: navigate`, or `Accept` listing `text/html`) a 303 to
  `authn.oidc.redirects.failure`, any other request the 401 login failure body. Both clear the flow cookie and carry
  `Retry-After`.
- No response of these routes carries `X-RateLimit-*` headers, and the app cannot turn them on: the schema refuses
  `headers` in `authn.oidc.rateLimit.begin` and `.callback`.
- Back-channel logout is never limited. The IdP sends one logout token per session, server to server, from a few
  addresses. A mass revocation (a disabled user, an IdP-wide logout) goes past any per-address cap, most IdPs do not
  retry a refused token, and each refusal leaves alive a session that should have ended. The signed logout token is
  its guard. The route declares `@RateLimit({ config: false })`, so a global floor in `http.routes.middlewares` does
  not reach it either.
- The defaults are generous on purpose: an office behind one NAT address signing in at 9 a.m. makes a begin and a
  callback per login. Raise them for a larger site rather than turning them off.

## Configuration

```ts
export default {
  authn: {
    oidc: {
      rateLimit: {
        begin: { limit: 300 }, // windowSeconds and by from the default
        callback: { limit: 300 },
        // callback: false,    // no limit on the callback
      },
    },
  },
};
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `authn.oidc.rateLimit.begin` | `{ limit?, windowSeconds?, by? }` or `false` | `{ limit: 60, windowSeconds: 60, by: 'ip' }` | Merged over the default; `false`: no limit on the begin route. |
| `authn.oidc.rateLimit.callback` | `{ limit?, windowSeconds?, by? }` or `false` | `{ limit: 60, windowSeconds: 60, by: 'ip' }` | The same for the callback. |

- Read once, when the routes mount; a change needs a restart. A wrong value fails the boot.
- There is no key for back-channel logout: the schema refuses `authn.oidc.rateLimit.backchannelLogout`.
- A global floor in `http.routes.middlewares` (`RateLimitMiddleware` for every route) does not reach back-channel
  logout. A coarse `http.throttle` path rule over `/auth` does: path rules cannot be opted out from code ([the two layers](../http/18-throttling.md#rate-limits-for-the-authn-routes)).
- Counters are per process with `MemoryThrottleStore`. Behind a proxy set `http.trustProxy` or `authn.http.trustProxy`, or
  every client shares the proxy's address and one budget.

## Related

- [Login flow](01-login-flow.md): the begin and callback routes and their failure answer.
- [Back-channel logout](11-backchannel-logout.md): the route left unlimited.
- [`@spinajs/authn-http` rate limits](../authn-http/25-rate-limits.md): the limits of the other anonymous routes.
- [Throttling](../http/18-throttling.md): `@RateLimit`, `ThrottleStore` and the coarse `http.throttle` layer.
