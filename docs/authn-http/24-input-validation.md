# Input validation

Every route of the package takes its input through route arguments: a body DTO with an inline `@Schema`, `@Param` with
a schema, `@Header`, and `@ClientContext()` for the caller. No handler reads `req.body` field by field. A body the
schema refuses is answered by the route itself, with the answer it always gave for bad input: the uniform login failure
on the credential routes, the route's own 400 code elsewhere.

## How it works

1. The global middlewares run first: `ClientIp`, the CSRF guard and `AuthnMiddleware` (see [Request authentication](01-request-authentication.md)).
2. The route's policies run: the group gates (`PasswordServiceRegistered`, `KeyRoutesOn`, ...), `Authenticated`, and the session state policies `PendingSessionOnly` (MFA completion) and `ActiveSessionOnly` (step-up, re-authentication).
3. The route middlewares run: on the anonymous routes that read a body, the [IP throttle gate](#the-ip-throttle-gate) first, then [`@BotCheck`](23-bot-checks.md).
4. The arguments are extracted and validated. The DTO schemas have `authn.` ids, so `@spinajs/validation` checks them without type coercion: `{ "login": 123 }` fails. Every DTO is closed: an unknown field fails.
5. A validation failure goes to the route's `@OnError` handler at the `arguments` stage, which answers it (see the table below). The action never runs.
6. The action runs with typed, capped values.

So a malformed body never reaches a strategy, a throttle account key, a re-authentication or a log line, and an
anonymous client cannot avoid the ip throttle by sending bad bodies.

## The DTOs and their answers

The DTO classes live in `src/dto/` and are not exported; the OpenAPI document shows their schemas as the request bodies.
Caps are those of `@spinajs/authn/schemas` (`loginField`, `passwordField`, `secretField`, `codeField`: 1024 characters;
`kidField`; `isoInstantField`; `identityRefField`; `tokenIdField`: 64; `sessionHandleField`: 128; `mfaStepField`: 64).

| Route | Input | A refused input answers |
| --- | --- | --- |
| `POST /auth/login`, `/auth/code/login`, `/auth/keys/login`, `/auth/passkeys/login` | `{ login, password }`, `{ login, code }`, `{ keyId, challengeId, signature }`, `{ challengeId, response }` | 401 login failure body; a session the caller held ends, as on any failed login |
| `POST /auth/code/request`, `/auth/password/reset-request` | `{ login }` | 400 `invalid_login`; unknown field 400 `invalid_field` |
| `POST /auth/password/reset` | `{ login, secret, password, confirmPassword? }` | 400 `invalid_password`, `password_rejected` `['too_long']` or `password_mismatch` for the new password; 401 login failure body for anything else |
| `PATCH /user/password` | `{ oldPassword, password, confirmPassword? }` | as the reset for the new password; 401 for `oldPassword`; 400 `invalid_field` |
| `POST /auth/register` | `{ login, email, password, confirmPassword? }` | 400 `invalid_login`, `invalid_email` (the `email` format), the new password codes, `invalid_field` |
| `POST /auth/verify` | `{ secret }` | 400 `invalid_secret`; `invalid_field` |
| `POST /auth/reauth` | `{ password }` | 401 login failure body |
| `POST /auth/mfa/verify`, `/recovery`, `/step-up` | `{ code, step? }`, `{ code }`, `{ code, step? }` | 401 login failure body |
| `POST /auth/mfa/challenge` | `{ step? }` | 202 `{ Ok: true }`, as always |
| `/user/mfa`, `/confirm`, `/disable`, `/recovery-codes` | `{ reauthPassword? }`, `{ code }`, `{ code, reauthPassword? }` | 401 login failure body for a code or password; 400 `invalid_field` |
| `POST /auth/active-role` | `{ role, password? }` | 400 `invalid_role`; 401 for a password that is no string; 400 `invalid_field` |
| `POST /auth/impersonate` | `{ target, password? }` | 400 `invalid_target`; 401; 400 `invalid_field` |
| `DELETE /user/sessions/:handle` | `:handle` at most 128 | 404 `session_not_found` |
| `POST /user/keys` | `{ jwk, proof, kid?, name?, expiresAt?, reauthPassword? }` | 400 `invalid_key`, `invalid_kid`, `invalid_name`, `invalid_expiry`, `invalid_proof`, `invalid_scope` for a `scope`, `invalid_field` |
| `POST /auth/keys/challenge` | `{ purpose, kid? }` (a login needs `kid`) | 400 `invalid_purpose`, `invalid_kid`, `invalid_field` |
| `DELETE /user/keys/:kid` | `:kid` | 404 `key_not_found` |
| `POST /user/tokens` | `{ name, expiresAt, kind?, roles?, profile?, scope?, reauthPassword? }` | 400 `invalid_name`, `invalid_expiry`, `invalid_kind`, `invalid_roles`, `invalid_profile`, `invalid_scope`, `invalid_field` |
| `POST /user/tokens/:uuid/rotate`, `PATCH /user/tokens/:uuid`, `DELETE /user/tokens/:uuid` | `{ graceSeconds?, reauthPassword? }`, `{ name?, roles?, expiresAt? }`, `:uuid` at most 64 | 400 `invalid_grace`, the field codes (`invalid_field` first on a narrowing), 404 `token_not_found` |
| `POST /auth/tokens/revoke` | `{ token, token_type_hint? }` | 200 `{}`, revoking nothing |
| `POST /user/passkeys/options`, `/user/passkeys`, `DELETE /user/passkeys/:id` | `{ reauthPassword? }`, `{ challengeId, response, name?, reauthPassword? }`, `:id` | 400 `invalid_response`, `invalid_name`, `invalid_field`; 404 `passkey_not_found` |
| `/authn/admin/users/:uuid/...` | `:uuid` (a lower-case uuid), `{ sendReset?, reauthPassword? }` | 404 `not_found` first, then 400 `invalid_send_reset` or `invalid_field` |

A `reauthPassword` (and the `password` of a re-authentication, a role switch or an impersonation) has no length cap in
its schema: `reauthCredentials` refuses a longer one as a failed re-authentication and audits it as
`password_too_long`. One that is no string answers the login failure body.

## The caller: `@ClientContext()`

`@ClientContext()` resolves to an `AuthnClientContext` `{ ip?, userAgent?, session?, principal? }`: the `ClientIp`
(never Express's ip), the user agent, the restored session (pending included, so not authentication) and the
principal. Use it, with the [other route arguments](06-route-arguments.md), instead of `@Req()`. `POST /auth/logout` is
the one handler that still takes `@Req()`: `AuthnLogoutExtension.afterLogout(session, req)` receives the request.

## The inline password leaves the request

The bodies that carry a `reauthPassword` (or the role switch and impersonation `password`) are taken with
`@Body({ sensitive: [...] })`: once the DTO holds the value, `@spinajs/http` deletes the field from `req.body` and drops
`req.rawBody`, so no later reader of the request, a log among them, sees the password. The `FreshAuth` policy still
removes `reauthPassword` itself for routes that use it.

## The IP throttle gate

`AuthnIpThrottleMiddleware`, put on a route with `@IpThrottle(flow, answer, mode)`, keys the client ip with
`ipKey` (`authn.throttle.ipv6Prefix`) in a throttle flow.

- `gate` (default): it peeks the ip key of the flow and refuses while it is held, before the bot check and before the
  body is read. It counts nothing for a request it lets through, because the service behind counts the requests it
  takes. A body the route's DTO refuses is counted against the ip key, so invalid bodies from one client reach the
  throttled answer after the flow's `free` attempts, and a refused request is never validated. A throttle without
  `peek()` is not gated before validation, but invalid bodies are still counted and refused once over the limit.
- `count`: every request counts (the token revocation route, whose service counts nothing).

| Route | Flow | Throttled answer |
| --- | --- | --- |
| `POST /auth/login`, `/auth/code/login`, `/auth/keys/login`, `/auth/passkeys/login` | `login` | 401 login failure body with `Retry-After` |
| `POST /auth/keys/challenge` | `login` | 429 `throttled` |
| `POST /auth/code/request`, `/auth/password/reset-request`, `/auth/verify` | `reset` | 429 `throttled` |
| `POST /auth/password/reset` | `reset` | 401 login failure body with `Retry-After` |
| `POST /auth/register` | `register` | 429 `throttled` |
| `POST /auth/tokens/revoke` | `reset` (`count`) | 429 `throttled` |

The account keys stay in the services, which need the validated login.

## Important behaviour

- A body is checked **before** fresh authentication, the key, token and passkey checks and the credential admin
  guard. A malformed body costs no re-authentication attempt; a stale session sending one gets its 400, not
  `fresh_auth_required`.
- `@spinajs/http` extracts route arguments from the last parameter to the first. The token and credential admin
  handlers order their parameters so that the same field is refused first as before (the body before the token id,
  the admin `:uuid` before the body).
- A route parameter typed `string | undefined` reaches the route arguments as `Object`, whose values are parsed as JSON;
  declare such parameters `string`.

## Related

- [Route groups](07-route-groups.md) and the OpenAPI schemas.
- [Error handling: route error handlers](../http/11-error-handling.md) for `@OnError`.
- [Route arguments](../http/04-route-arguments.md) for `@Body({ sensitive })`.
- [Field schemas](../authn/README.md) of `@spinajs/authn/schemas`.
