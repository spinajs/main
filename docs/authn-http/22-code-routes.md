# Code routes

`AuthnCodeLoginController` serves the login with a mailed code of [`@spinajs/authn-local`](../authn-local/15-email-codes.md): an anonymous caller asks for a code by login, then logs in with it. The routes are on while the registered `PasswordService` offers `requestCode`, as `LocalPasswordService` does. Otherwise both answer 404. The login needs the `email-code` strategy in `authn.strategies`; without it `POST /auth/code/login` answers the login failure body.

The code as a second factor uses `POST /auth/mfa/challenge` instead; see [Login, logout and MFA routes](08-login-logout-and-mfa-routes.md#post-authmfachallenge).

## How it works

### `POST /auth/code/request`

1. The gate `CodeLoginRegistered` answers `404 { "error": "not_found" }` while no `PasswordService` is registered or it has no `requestCode`.
2. The body is `{ login }`, a non-empty string of at most 1024 characters; anything else answers `400 { "error": "invalid_login" }`.
3. `PasswordService.requestCode(login, ctx)` runs with purpose `'request'` and the client ip.
4. It answers `202 { "Ok": true }` with `Cache-Control: no-store`, whether or not the account exists and whether or not a mail goes out. A failure of the service is logged by its error name and answers the same 202. A throttled request answers 429 `throttled` with `Retry-After`. The throttle is the `reset` flow, keyed on the login and the client ip.

### `POST /auth/code/login`

1. The body is `{ login, code }`, both non-empty strings of at most 1024 characters.
2. The route ends a session the caller holds, then authenticates `{ kind: 'email-code', login, code }` like `POST /auth/login` does.
3. Success: `200` with the session cookie and the principal summary with the login extensions (method `email-code`, assurance `aal1`). If the MFA policy asks for a step for this method, the answer is `{ "MfaRequired": [...] }` with the pending session cookie.
4. Every failure, a missing field, a wrong, spent or expired code and an unknown login included, answers the 401 login failure body, with `Retry-After` when throttled.

## Example

```http
POST /auth/code/request HTTP/1.1
Content-Type: application/json

{ "login": "alice@example.com" }
```

```http
POST /auth/code/login HTTP/1.1
Content-Type: application/json

{ "login": "alice@example.com", "code": "482913" }
```

## Important behaviour

- Neither route needs a session. The [CSRF origin guard](04-csrf-origin-guard.md) checks them like the other credential routes.
- The code travels only in the mail. The request answer is the same for every login.
- Five wrong codes void the code; ask for a new one.
