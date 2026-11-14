# Rate limits

The account administration writes, the user list and the metadata writes carry a [`@RateLimit`](../http/18-throttling.md#the-options-form-configured-limits-answer-headers-key) that is on by default. Each reads `users.http.rateLimit.<name>` once, when the route is mounted: an object overrides the shipped numbers, `false` takes the limit off the route.

| Config key `users.http.rateLimit.` | Routes | Default | Why |
| --- | --- | --- | --- |
| `create` | `POST /users` | 30 per 600 s | An admin creating accounts. |
| `security` | `POST /users/security/{deactivate,activate,ban,unban}/:user`, `DELETE /users/security/sessions/:user/:handle`, `DELETE /users/:user`, `PATCH /users/:uuid/restore` | 60 per 600 s | Bounds a mass lock-out by a compromised admin session. |
| `list` | `GET /users` | 120 per 60 s | Caps scraping through the filters. |
| `metadata` | `POST /user/metadata`, `PATCH` and `DELETE /user/metadata/:meta`, `POST /user/:user/metadata`, `PATCH` and `DELETE /user/:user/metadata/:meta` | 60 per 60 s | Otherwise unbounded row writes per user. |

- Each route counts apart, also where routes share a key.
- Every limit counts the principal (`by: 'principal'`, `req.storage.Principal`). While an admin impersonates a user, the principal is that user, so **an impersonator spends the impersonated user's budget**.
- Over the limit a route answers the default 429 `E_TOO_MANY_REQUESTS` with `Retry-After`. No response carries `X-RateLimit-*` unless `users.http.rateLimit.<name>.headers: true`.
- `PATCH /users/:user`, the single-user reads, the session list and the `/user` own reads have no limit.
- The limit runs after `@Access`: a refused request is not counted.
- With `MemoryThrottleStore` every process counts apart; register a shared `ThrottleStore` for several instances.

## Configuration

```ts sample
const config = {
  users: {
    http: {
      rateLimit: {
        // an onboarding import that creates many accounts
        create: { limit: 500, windowSeconds: 3600 },
        list: false,
      },
    },
  },
};

export default config;
```

An entry is `{ limit?, windowSeconds?, by?, headers? }` merged over the default (`by` is `'ip'` or `'principal'`), or `false`. The schema (module `users.http.rateLimit`, registered by this package) refuses an unknown name and a value the middleware cannot enforce at boot.
