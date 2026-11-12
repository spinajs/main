# Rate limits on the anonymous routes

Every anonymous route that checks a credential, redeems a secret, sends a mail or writes a challenge carries a
[`@RateLimit`](../http/18-throttling.md#per-route-limits-ratelimit) of `@spinajs/http`, **on by default**. It caps how
many requests one client address may send to the route in a fixed window. It is a volume cap, not the guessing
defence: the [authn throttle](../authn/README.md) (per account and per IP, counted before the credential is checked)
and the [IP throttle gate](24-input-validation.md#the-ip-throttle-gate) stay as they are.

Each limit reads its numbers from `authn.http.rateLimit.<name>` once, when the routes mount. `false` there takes the
limit off the route.

| Route | Config key | Default | Throttled answer |
| --- | --- | --- | --- |
| `POST /auth/login` | `authn.http.rateLimit.login` | 30 / 60 s | 401 login failure body with `Retry-After` |
| `POST /auth/code/login` | `authn.http.rateLimit.codeLogin` | 30 / 60 s | 401 login failure body with `Retry-After` |
| `POST /auth/keys/login` | `authn.http.rateLimit.keysLogin` | 30 / 60 s | 401 login failure body with `Retry-After` |
| `POST /auth/passkeys/login` | `authn.http.rateLimit.passkeysLogin` | 30 / 60 s | 401 login failure body with `Retry-After` |
| `POST /auth/keys/challenge` | `authn.http.rateLimit.keysChallenge` | 30 / 60 s | 429 `throttled` |
| `POST /auth/passkeys/challenge` | `authn.http.rateLimit.passkeysChallenge` | 30 / 60 s | 429 `throttled` |
| `POST /auth/code/request` | `authn.http.rateLimit.codeRequest` | 10 / 600 s | 429 `throttled` |
| `POST /auth/password/reset-request` | `authn.http.rateLimit.passwordResetRequest` | 10 / 600 s | 429 `throttled` |
| `POST /auth/password/reset` | `authn.http.rateLimit.passwordReset` | 10 / 600 s | 401 login failure body with `Retry-After` |
| `POST /auth/verify` | `authn.http.rateLimit.verify` | 20 / 600 s | 429 `throttled` |
| `POST /auth/register` | `authn.http.rateLimit.register` | 10 / 3600 s | 429 `throttled` |

Every default counts per client address (`by: 'ip'`); an IPv6 client counts per network of `http.throttle.ipv6Prefix`
bits (64 by default). The OIDC routes have [their own limits](../authn-oidc/13-rate-limits.md).

No limit ships on `POST /auth/tokens/revoke` (its IP throttle already counts every request), `POST /auth/logout`,
`GET /auth`, `GET /auth/password/policy` and `GET /.well-known/jwks.json`.

## How it works

- The limit is an `'outer'` route middleware: it runs after the policy gate and before `@BotCheck`, the IP throttle
  gate, the body validation and the action. A refused request costs no bot verifier call, no authn throttle read (a
  `DbAuthnThrottle` query) and no password hash; it costs one increment in the http `ThrottleStore`.
- A refused client gets the **same answer** the route's IP throttle gives, with the same status, body and headers:
  the uniform 401 login failure body with `Retry-After` on the credential routes (A02), the route's 429 `throttled`
  body with `Retry-After` elsewhere. The `Retry-After` value differs (the rest of the window here, the backoff
  there); both limiters count the address only, so neither tells anything about an account.
- No response of these routes carries `X-RateLimit-*` headers (`headers: false`): they would tell a throttled client
  from a failed login. The app cannot turn them on: `headers` is not a key of `authn.http.rateLimit.<name>`.
- `POST /auth/passkeys/challenge` also serves the WebAuthn step of a pending (pre-MFA) session. Such a request counts
  on its own pending session, not on the address, so users who passed their password do not spend the anonymous
  budget of a shared address. The key is an HMAC of the session id under `http.cookie.secret`, domain separated, so
  the throttle store (possibly shared) holds neither the id nor the session store's own key; without a secret the
  request counts on the address.
- Each pending session has its own 30 a minute. A client that holds the password of an account with a passkey step
  can open one pending session per successful login (itself 30 a minute per address), so one address can ask for up
  to about 900 such challenges a minute. Before 4.0 these challenges had no limit at all; a coarse `http.throttle`
  rule on `/auth` caps the address as a whole.
- Counters live in the `ThrottleStore` of `@spinajs/http`: `MemoryThrottleStore` counts per process. Behind several
  instances, register a shared store, or each instance allows the full limit.
- The address is `req.storage.realIp`, the same client address the authn throttle counts: `authn.http.trustProxy`,
  else `http.trustProxy` ([one client address](../http/17-client-ip-and-trust-proxy.md#one-client-address-with-authn)).
  Behind a reverse proxy set one of them, or every client shares the proxy's address and one budget: one client then
  locks everyone out of the route.

## Configuration

```ts
export default {
  authn: {
    http: {
      rateLimit: {
        login: { limit: 120 }, // a large office behind one NAT address; windowSeconds and by from the default
        register: { limit: 50, windowSeconds: 3600 },
        verify: false, // no limit on POST /auth/verify
      },
    },
  },
};
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `authn.http.rateLimit.<name>` | `{ limit?, windowSeconds?, by? }` or `false` | the table above | Merged over the route's default. `limit` is an integer ≥ 0 (`0` closes the route), `windowSeconds` a number > 0, `by` `'ip'` or `'principal'`. `false`: no limit on the route. |

- The schema refuses an unknown route name, an unknown setting (a misspelt `limt`, or `headers`) and a value out of range at boot.
- The numbers are read once, when the routes mount; a change needs a restart.
- Changed numbers start fresh counters: the store key holds the limit and the window.
- The defaults are exported as `AUTHN_HTTP_RATE_LIMITS`.

## The two layers

The shipped limits are the per-route layer. `http.throttle` path rules are the coarse layer that runs before
authentication; the split is in [Throttling: the authn routes](../http/18-throttling.md#rate-limits-for-the-authn-routes).

## Best practices

- Raise the NAT-sensitive defaults (login, the code and reset requests, registration) when many users share one
  address: an office, a campus, a mobile carrier-grade NAT.
- Prefer raising a limit to `false`: the limit is what stops a flood before the bot check and the authn throttle.
- Keep the authn throttle on: the rate limit caps volume, it does not stop a slow guessing attack on one account.

## Related

- [Throttling](../http/18-throttling.md): `@RateLimit`, `ThrottleStore`, `http.throttle`.
- [Input validation](24-input-validation.md#the-ip-throttle-gate): the IP throttle gate behind the rate limit.
- [Bot checks](23-bot-checks.md): the check the rate limit runs before.
- [Request authentication](01-request-authentication.md): `ClientIp` and the proxy trust.
