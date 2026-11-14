# Rate limits of the link and reauth routes

The routes that need a signed-in session carry a [`@RateLimit`](../http/18-throttling.md#the-options-form-configured-limits-answer-headers-key) that is on by default. Each reads `authn.oidc.rateLimit.<name>` once, when the route is mounted: an object overrides the shipped numbers, `false` takes the limit off the route.

| Config key `authn.oidc.rateLimit.` | Routes | Default | Why |
| --- | --- | --- | --- |
| `link` | `POST /auth/oidc/:provider/link`, `DELETE /auth/oidc/:provider/link` | 10 per 600 s | Changes the account's links. |
| `reauth` | `GET /auth/oidc/:provider/reauth` | 10 per 300 s | Each call starts a round trip to the provider. |

- Both count the principal (`by: 'principal'`): `req.storage.Principal`, else `req.storage.AuthnPrincipal`; a request without one is counted per client address. While an admin impersonates a user, the principal is that user, so **an impersonator spends the impersonated user's budget**.
- Each route counts apart: `POST` and `DELETE .../link` each allow 10.
- Over the limit a route gets the one failure answer of the OIDC routes, as begin and callback do ([Rate limits](13-rate-limits.md)): a browser navigation is redirected (303) to `authn.oidc.redirects.failure`, any other request gets 401 with the login failure body; both with `Retry-After`. No response carries `X-RateLimit-*` headers.
- `POST /auth/oidc/:provider/backchannel-logout` is never limited: a refused logout token leaves alive a session that should have ended ([Back-channel logout](11-backchannel-logout.md)).
- With `MemoryThrottleStore` every process counts apart; register a shared `ThrottleStore` for several instances.

```ts sample
const config = {
  authn: {
    oidc: {
      rateLimit: {
        reauth: { limit: 30, windowSeconds: 600 },
        link: false,
      },
    },
  },
};

export default config;
```

An entry is `{ limit?, windowSeconds?, by? }` merged over the default (`by` is `'ip'` or `'principal'`), or `false`. The `authn.oidc` schema refuses an unknown name, `headers` (these routes send no `X-RateLimit-*`) and a value the middleware cannot enforce at boot.
