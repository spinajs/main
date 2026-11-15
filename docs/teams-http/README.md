# `@spinajs/teams-http`

The REST API over [`@spinajs/teams`](../teams/README.md): teams, groups, members and invitations under `/teams`, `/groups`, `/invitations` and `/user/teams`. Every route is guarded by `@Access` (or `IsAuthenticated` for accepting an invitation) and calls the `TeamService`, `GroupService` and `InvitationService` of `@spinajs/teams`. `TEAMS_HTTP_CONTROLLERS` lists the controllers and `TEAMS_HTTP_ROUTES` the routes.

## Install

```sh
npm install @spinajs/teams-http
```

Its shipped config adds the controllers to the directory scan.

## Rate limits

The routes that create teams or send mail carry a [`@RateLimit`](../http/18-throttling.md#the-options-form-configured-limits-answer-headers-key) that is on by default. Each reads `teams.http.rateLimit.<name>` once, when the route is mounted: an object overrides the shipped numbers, `false` takes the limit off the route.

| Config key `teams.http.rateLimit.` | Route | Default | Why |
| --- | --- | --- | --- |
| `create` | `POST /teams` | 20 per 3600 s | Creates hierarchy rows and authz tuples. |
| `invite` | `POST /teams/:team/invitations` | 20 per 3600 s | An email invitation sends a mail: a spam lever through the app's own mailer. |
| `resend` | `POST /teams/:team/invitations/:invitation/resend` | 10 per 3600 s | Sends the mail again. |
| `accept` | `POST /invitations/accept` | 10 per 600 s | Defence in depth: the 32-byte token cannot be guessed. |

- Every limit counts the principal (`by: 'principal'`, `req.storage.Principal`). While an admin impersonates a user, the principal is that user, so **an impersonator spends the impersonated user's budget**.
- `resend` counts the caller, not the invitation: the invitation id comes from the path before the action looks it up, and a counting key a client picks gets a fresh counter for every value it sends.
- Over the limit a route answers the default 429 `E_TOO_MANY_REQUESTS` with `Retry-After`. No response carries `X-RateLimit-*` unless `teams.http.rateLimit.<name>.headers: true`.
- The other structural writes and the reads have no limit. The limit runs after the route's `@Access`: a refused request is not counted.
- With `MemoryThrottleStore` every process counts apart; register a shared `ThrottleStore` for several instances.

```ts sample
const config = {
  teams: {
    http: {
      rateLimit: {
        // onboarding sends many invitations at once
        invite: { limit: 200 },
        accept: false,
      },
    },
  },
};

export default config;
```

An entry is `{ limit?, windowSeconds?, by?, headers? }` merged over the default (`by` is `'ip'` or `'principal'`), or `false`. The schema (module `teams.http.rateLimit`, registered by this package) refuses an unknown name and a value the middleware cannot enforce at boot.

## Related packages

- [`@spinajs/teams`](../teams/README.md): the services behind every route.
- [`@spinajs/authz-http`](../authz-http/README.md): `@Access`, `IsAuthenticated` and `@CurrentPrincipal()`.
- [`@spinajs/http`](../http/README.md): `@RateLimit` and the `ThrottleStore`.
