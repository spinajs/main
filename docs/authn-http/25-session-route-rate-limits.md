# Rate limits of the routes with a session

Every route that needs a session and spends something per call (a password hash, a code check, a mail, a new credential) carries a [`@RateLimit`](../http/18-throttling.md#the-options-form-configured-limits-answer-headers-key) that is on by default. Each limit reads `authn.http.rateLimit.<name>` once, when the route is mounted: an object overrides the shipped numbers, `false` takes the limit off the route.

These limits cap volume. The service-side `AuthnThrottle` backoff (the `mfa` and `reauth` flows) still guards against guessing, and still answers first once it holds an account.

## The limits

| Config key `authn.http.rateLimit.` | Routes | Default | Counted by | Throttled answer |
| --- | --- | --- | --- | --- |
| `mfaVerify` | `POST /auth/mfa/verify`, `POST /auth/mfa/recovery` | 10 per 300 s | the pending session; the client address without one | 401, the login failure body, `Retry-After`; no `X-RateLimit-*` |
| `mfaChallenge` | `POST /auth/mfa/challenge` | 5 per 600 s | the pending session; the client address without one | 202 `{ Ok: true }`, what every challenge answers; no `X-RateLimit-*` |
| `mfaStepUp` | `POST /auth/mfa/step-up` | 10 per 300 s | principal | 401, the login failure body, `Retry-After`; no `X-RateLimit-*` |
| `reauth` | `POST /auth/reauth` | 10 per 300 s | principal | 401, the login failure body without `Retry-After`, as a throttled password; no `X-RateLimit-*` |
| `activeRole` | `POST /auth/active-role` | 20 per 60 s | principal | 429 |
| `impersonate` | `POST /auth/impersonate` | 10 per 600 s | principal | 429 |
| `passwordChange` | `PATCH /user/password` | 10 per 600 s | principal | 429 |
| `verifyRequest` | `POST /auth/verify/request` | 5 per 3600 s | principal | 429, `too many verification requests` |
| `tokens` | `POST /user/tokens`, `POST /user/tokens/:uuid/rotate` | 20 per 600 s | principal | 429 |
| `keys` | `POST /user/keys` | 20 per 600 s | principal | 429 |
| `passkeys` | `POST /user/passkeys/options`, `POST /user/passkeys` | 20 per 600 s | principal | 429 |
| `mfaEnrolment` | `POST /user/mfa`, `/user/mfa/confirm`, `/user/mfa/disable`, `/user/mfa/recovery-codes` | 10 per 600 s | principal | 429 |
| `adminPasswordReset` | `POST {admin}/:uuid/password-reset` | 30 per 600 s | principal | 429 |
| `adminCredentials` | `POST {admin}/:uuid/mfa-reset`, `DELETE {admin}/:uuid/sessions`, `DELETE {admin}/:uuid/tokens` | 60 per 600 s | principal | 429 |

- "429" is authn's own throttled body, `{ "error": "throttled", "message": "too many requests, try again later" }` with `Retry-After` and `Cache-Control: no-store`, the body a throttled reset or verification request gets. These routes also get the `X-RateLimit-*` headers.
- The MFA and re-authentication routes keep the uniform answer (A02): a client cannot tell the limit from a wrong code, so they send no `X-RateLimit-*` headers.
- Each route counts apart, also where two routes share a config key: `mfa/verify` and `mfa/recovery` each allow 10.
- Reads and deletes of the caller's own tokens, keys, passkeys and sessions, `GET /user/mfa`, `GET` and `DELETE /auth/impersonate` and `GET /auth/active-role` have no limit.

## What is counted

- **The pending session** (MFA routes): a pending session has no principal yet. The key is an HMAC-SHA-256 of the session `AuthnMiddleware` restored, under `http.cookie.secret`, so the store never holds a usable session id and every instance with the same secret counts on the same key. Nothing the client sends picks the key: a new key needs a new pending session, which only a successful first factor creates. Without a restored pending session, the request counts on its client address.
- **The principal**: `req.storage.Principal` (from `@spinajs/authz-http`), else `req.storage.AuthnPrincipal`. While an admin impersonates a user, the principal is that user, so **an impersonator spends the impersonated user's budget**, not their own. Of these routes only `POST /auth/mfa/step-up`, `POST /auth/reauth` (which refuses an impersonation after counting) and `POST /auth/impersonate` admit an impersonating session; the others refuse it before the limit counts.
- With `MemoryThrottleStore` every process counts apart. Register a shared `ThrottleStore` when the app runs on several instances ([Stores](../http/18-throttling.md)).

## Configuration

```ts sample
const config = {
  authn: {
    http: {
      rateLimit: {
        // a larger enrolment window for a help desk that walks users through it
        mfaEnrolment: { limit: 30 },
        // an internal tool that mints tokens in bulk
        tokens: { limit: 200, windowSeconds: 3600 },
        // no limit at all on the role switch
        activeRole: false,
      },
    },
  },
};

export default config;
```

- An entry is `{ limit?, windowSeconds?, by? }` merged over the default, or `false`. `by` is `'ip'` or `'principal'`.
- The schema refuses an unknown name, a negative or fractional `limit`, a `windowSeconds` that is not positive and any other `by` at boot. Changed numbers count on a key of their own, so new numbers start fresh windows.
- These limits run as `'outer'` route middlewares: after the policy gate, so a request a policy refuses is not counted, and after the session restore and token checks. The coarse `http.throttle` path rule runs before all of that; see [the two layers](../http/18-throttling.md#recommended-rules-for-the-authn-routes).
