# Rate limits

The batch check, the access event stream and the explain route carry a [`@RateLimit`](../http/18-throttling.md#the-options-form-configured-limits-answer-headers-key) that is on by default. Each reads `authz.http.rateLimit.<name>` once, when the route is mounted: an object overrides the shipped numbers, `false` takes the limit off the route.

| Config key `authz.http.rateLimit.` | Route | Default | Why |
| --- | --- | --- | --- |
| `checks` | `POST /user/access/checks` | 120 per 60 s | A batch of up to 100 checks: the cost grows with the batch. |
| `events` | `GET /user/access/events` | 10 per 60 s | Open streams are capped by `authz.http.events.maxStreamsPerPrincipal`; this caps the reconnects, each of which closes the oldest stream and opens a new one. |
| `explain` | `GET /authz/explain` | 30 per 60 s | A full decision trace, the most expensive authz read. Mounted only when `authz.http.explainRoute.enabled` and never in production. |

- Every limit counts the principal (`by: 'principal'`): `req.storage.Principal`. An anonymous caller is counted per client address. While an admin impersonates a user, the principal is that user, so **an impersonator spends the impersonated user's budget**.
- Over the limit the route answers the default 429 `E_TOO_MANY_REQUESTS` with `Retry-After`. No response carries `X-RateLimit-*` unless `authz.http.rateLimit.<name>.headers: true`.
- A browser's `EventSource` does not reconnect after a 429, so a multi-page app that opens the stream on every page view loses live updates past the 10th view a minute: raise `events` for such an app.
- `GET /user/access` has no limit.
- The limit runs after the policy gate: a request `HasPrincipal`, `IsAuthenticated` or `ExplainPolicy` refuses is not counted.
- With `MemoryThrottleStore` every process counts apart; register a shared `ThrottleStore` for several instances.

## Configuration

```ts sample
const config = {
  authz: {
    http: {
      rateLimit: {
        // a client that checks a whole menu on every page view
        checks: { limit: 600 },
        events: false,
      },
    },
  },
};

export default config;
```

An entry is `{ limit?, windowSeconds?, by?, headers? }` merged over the default (`by` is `'ip'` or `'principal'`), or `false`. The schema refuses an unknown name and a value the middleware cannot enforce at boot.
