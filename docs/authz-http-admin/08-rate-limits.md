# Rate limits

The command batch and every write route carry a [`@RateLimit`](../http/18-throttling.md#the-options-form-configured-limits-answer-headers-key) that is on by default. Each reads `authz.http.admin.rateLimit.<name>` once, when the route is mounted: an object overrides the shipped numbers, `false` takes the limit off the route. Authorization stays the real guard; the limits bound the write volume, the changelog rows and the cache invalidation one session can cause.

| Config key `authz.http.admin.rateLimit.` | Routes | Default |
| --- | --- | --- |
| `commands` | `POST /authz/commands` | 60 per 60 s |
| `writes` | `POST /authz/assignments`, `PATCH` and `DELETE /authz/assignments/:id`, `POST /authz/links`, `PATCH` and `DELETE /authz/links/:id`, `PUT` and `DELETE /authz/rules/:id`, `PUT` and `DELETE /authz/policies/:id`, `PATCH` and `PUT /authz/scopes/:type/:id/attributes` | 120 per 60 s |

- The paths are under `authz.http.admin.basePath` (default `authz`). Each route counts apart, also where routes share the `writes` key.
- Every limit counts the principal (`by: 'principal'`, `req.storage.Principal`). While an admin impersonates a user, the principal is that user, so **an impersonator spends the impersonated user's budget**.
- Over the limit a route answers the default 429 `E_TOO_MANY_REQUESTS` with `Retry-After`. No response carries `X-RateLimit-*` unless `authz.http.admin.rateLimit.<name>.headers: true`.
- The `GET` lists and `GET /authz/scopes/:type/:id/attributes` have no limit.
- The limit runs after `IsAuthenticated`: an anonymous request is refused before it counts.
- With `MemoryThrottleStore` every process counts apart; register a shared `ThrottleStore` for several instances.

## Configuration

```ts sample
const config = {
  authz: {
    http: {
      admin: {
        rateLimit: {
          // a provisioning job that grants in bulk
          writes: { limit: 1000 },
          commands: { limit: 120, windowSeconds: 60 },
        },
      },
    },
  },
};

export default config;
```

An entry is `{ limit?, windowSeconds?, by?, headers? }` merged over the default (`by` is `'ip'` or `'principal'`), or `false`. The schema (module `authz.http.admin.rateLimit`, registered by this package) refuses an unknown name and a value the middleware cannot enforce at boot.
