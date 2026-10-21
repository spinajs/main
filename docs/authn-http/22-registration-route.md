# Registration route

`AuthnRegistrationController` serves self-service registration: a stranger posts a login, an email address and a password, and gets an account. The route is on while an `IdentityRegistrar` resolves. [`@spinajs/users`](../users/18-self-service-registration.md) provides it when `users.registration.enabled` is true. Otherwise `POST /auth/register` answers `404 { "error": "not_found" }`.

## How it works

1. The gate `IdentityRegistrarRegistered` answers 404 while no `IdentityRegistrar` is registered, or the registered one is switched off.
2. The body is `{ login, email, password, confirmPassword? }`. A missing or over-long login or email answers `400 invalid_login` or `400 invalid_email`; a missing password or a differing `confirmPassword` answers `400 invalid_password` or `400 password_mismatch`.
3. The attempt counts in the `register` throttle flow, keyed on the client ip (an IPv6 client on its `authn.throttle.ipv6Prefix` prefix) and on the lower-cased address. The flow has its own counters: registrations never use up the `reset` budget of the same address, and the reverse. Defaults: 3 free attempts per address, then 60 s up to 1 h; 10 per IP, then 30 s up to 1 h. A throttled request answers 429 `throttled` with `Retry-After`.
4. `PasswordService.check(password, { login, email })` applies the password policy, with the login and the email as the context of the similarity rule. A violation answers `400 password_rejected` with the `violations`. The violations depend on the input only, so they tell nothing about the account.
5. `IdentityRegistrar.register()` creates the account or finds the one that holds the address or the login.
6. It answers `202 { "status": "accepted" }` with `Cache-Control: no-store` in both cases:
   - **A new account.** The route asks for a verification mail (`PasswordService.requestVerification`, [address verification](../authn-local/14-address-verification.md)). With `authn.login.requireVerifiedAddress`, the account can sign in once the link is redeemed.
   - **A taken address or login.** Nothing is created. With `authn.http.registration.notifyExisting` (default `true`) the owner is sent an `account-exists` mail that holds no secret and links to the reset page (`PasswordService.notifyAccountExists`).
7. The route audits `identity.register`: `success` for a new account, `failure` with reason `exists` for a taken one.

A failure to queue the mail is logged and does not change the answer.

## Example

```http
POST /auth/register HTTP/1.1
Content-Type: application/json

{ "login": "ada", "email": "ada@acme.com", "password": "Correct-Horse-42" }
```

```http
HTTP/1.1 202 Accepted
Cache-Control: no-store

{ "status": "accepted" }
```

## Important behaviour

- The answer never tells a new address from a taken one: same status, same body, same code path. The `exists` path also spends one password hash, so the two do not differ by that cost. Timing is not constant beyond that: a new account also writes rows.
- A refused input the registrar judges itself (a reserved login, a login or email longer than users allows) answers `400 invalid_registration` with the `field`. It depends on the input only.
- The route is not in `authn.http.csrf.unauthenticatedRoutes`. Add `/auth/register` there to require an allowed origin on every browser request that has no session cookie.
- `authn.http.registration.notifyExisting: false` sends no mail to the owner of a taken address.

## Configuration

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `authn.http.registration.notifyExisting` | boolean | `true` | Mail the owner of a taken address that someone tried to register with it. |
