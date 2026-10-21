# Verification routes

`AuthnVerificationController` serves the address verification flow of [`@spinajs/authn-local`](../authn-local/14-address-verification.md): a signed-in user asks for a verification mail, and the link in it is redeemed anonymously. The routes are on while the registered `PasswordService` offers `requestVerification` and `redeemVerification`, as `LocalPasswordService` does. Otherwise both answer 404.

## How it works

### `POST /auth/verify/request`

1. The gate `AddressVerificationRegistered` answers `404 { "error": "not_found" }` while no `PasswordService` is registered or it offers no verification.
2. The route needs a session: 401 `unauthenticated` without one or with a pending (pre-MFA) session, 403 `session_required` for a token or key, 403 `impersonating` while impersonating.
3. `PasswordService.requestVerification(identity, ctx)` runs for the session's account, with purpose `'request'` and the client ip.
4. It answers `202 { "Ok": true }` with `Cache-Control: no-store`, whether or not a mail goes out. A throttled request answers 429 `throttled` with `Retry-After`. The throttle is the `reset` flow, keyed on the account.

### `POST /auth/verify`

1. The body is `{ secret }`, at most 1024 characters. The caller may be anonymous.
2. `PasswordService.redeemVerification(secret, ctx)` redeems it.
3. A verified address answers `200 { "Ok": true }`. Every refusal, a missing secret included, answers `400 { "error": "invalid_secret", "message": "the verification link is invalid or has expired" }`. The body is the same for every refusal.

## Example

```http
POST /auth/verify HTTP/1.1
Content-Type: application/json

{ "secret": "WyJ1c2VyIiwiNmY5…In0.q8Zr…" }
```

## Important behaviour

- `authn.local.verify.url` is the page the mail links to. It reads the `token` query parameter and posts it here as `secret`.
- These routes do not log anyone in. With `authn.login.requireVerifiedAddress`, the next login succeeds.
