# Registration route

`AuthnRegistrationController` serves self-service registration: a stranger posts a login, an email address and a password, and gets an account. The route is on while an `IdentityRegistrar` resolves. [`@spinajs/users`](../users/18-self-service-registration.md) provides it when `users.registration.enabled` is true. Otherwise `POST /auth/register` answers `404 { "error": "not_found" }`.

## How it works

1. The gate `IdentityRegistrarRegistered` answers 404 while no `IdentityRegistrar` is registered, or the registered one is switched off.
2. The body is `{ login, email, password, confirmPassword? }`. A missing or over-long login or email answers `400 invalid_login` or `400 invalid_email`; a missing password or a differing `confirmPassword` answers `400 invalid_password` or `400 password_mismatch`.
3. The attempt counts in the `reset` throttle flow, keyed on the client ip and on the lower-cased address. A throttled request answers 429 `throttled` with `Retry-After`.
4. `PasswordService.check(password, { login, email })` applies the password policy, with the login and the email as the context of the similarity rule. A violation answers `400 password_rejected` with the `violations`. The violations depend on the input only, so they tell nothing about the account.
5. The `authn.registration` [action hooks](23-action-hooks.md) run around the next steps, with `login` and `email` mutable. A refusal answers `400 { "error": "action_refused", "code" }` and audits an `identity.register` failure. A changed `login` or `email` goes through the password policy of step 4 again.
6. `IdentityRegistrar.register()` creates the account or finds the one that holds the address or the login. A refusal of an action it runs (`users.create`, `authn.password.set`) answers the 202 below, as a taken address does.
7. It answers `202 { "status": "accepted" }` with `Cache-Control: no-store` in both cases:
   - **A new account.** `RegistrationMailHook` asks for a verification mail (`PasswordService.requestVerification`, [address verification](../authn-local/14-address-verification.md)). With `authn.login.requireVerifiedAddress`, the account can sign in once the link is redeemed.
   - **A taken address or login.** Nothing is created. With `authn.http.registration.notifyExisting` (default `true`) `RegistrationMailHook` sends the owner an `account-exists` mail (`PasswordService.notifyAccountExists`). The mail holds no secret and links to the reset page.
8. The route audits `identity.register`: `success` for a new account, `failure` with reason `exists` for a taken one.

## The registration mails

`RegistrationMailHook` is an `after` hook on `authn.registration`. authn-http registers it with `@Injectable(ActionHook)`, and `@spinajs/authn-http` exports it. It runs once the registrar has answered, before the audit event.

- Both outcomes take the same path: one `send(outcome, ctx)` per registration, where `outcome` is the `RegistrationOutput` (`{ status: 'created' | 'exists', id }`) an application `after` hook sees too.
- A mail that cannot be requested (a queue down, a transport error) is logged on the `authn-http` log with its error class only, never the message or the address. The answer stays the same 202.
- A registration that a before hook refused, or that failed inside the registrar, sends no mail.
- The call is bounded by `hooks.timeoutMs`, as every hook call is.

To change a mail, extend the hook and override `send`:

```ts
import { Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import { RegistrationMailHook } from '@spinajs/authn-http';
import type { AuthnContext } from '@spinajs/authn/contracts';
import type { RegistrationOutput } from '@spinajs/authn-http';

@Injectable(ActionHook)
export class NoAccountExistsMail extends RegistrationMailHook {
  protected async send(outcome: RegistrationOutput, ctx: AuthnContext): Promise<void> {
    if (outcome.status === 'created') await super.send(outcome, ctx);
  }
}
```

Then `DI.unregister(RegistrationMailHook)` before the application boots, so only the subclass runs. To send no registration mail at all, unregister it and register nothing. Hooks are read once, when the runner resolves, so do both before anything resolves `Hooks`.

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
- `authn.http.registration.notifyExisting: false` sends no mail to the owner of a taken address. `RegistrationMailHook` reads it.

## Configuration

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `authn.http.registration.notifyExisting` | boolean | `true` | Mail the owner of a taken address that someone tried to register with it. |
