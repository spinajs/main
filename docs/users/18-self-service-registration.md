# Self-service registration

`UserIdentityRegistrar` is the `IdentityRegistrar` of `@spinajs/users`: it creates an account for a stranger through [`create()`](03-user-actions.md). [`POST /auth/register`](../authn-http/22-registration-route.md) of `@spinajs/authn-http` calls it. It is off by default.

## How it works

1. `RbacBootstrapper` registers a factory for `IdentityRegistrar`. The factory yields a `UserIdentityRegistrar` while `users.registration.enabled` is `true` and nothing otherwise, so the registration route answers 404 until you switch it on.
2. `register({ login, email, password }, ctx)` refuses a reserved login (`__name__`) with `InvalidArgument` first.
3. It looks for an account that holds the email or the login, soft-deleted ones included, an exact email match first. A taken address answers `{ status: 'exists', id }` and writes nothing. It hashes the password once on this path, so a taken address costs what a new account costs.
4. Otherwise it calls `create({ Email, Login, Password })` as `SYSTEM`. `create()` checks the password policy again, runs the `users.create` [action hooks](04-action-hooks.md), grants `authz.rbac.defaultRoles` and sets the password through `PasswordService.set`; `UserLifecycleMailHook` sends the `created` lifecycle mail. The account has no verified address yet.
   - A `users.create` hook that refuses (`ActionRefused`) or fails (`ActionHookFailed`) creates nothing. The registrar spends one password hash, as for a taken address, and rethrows the error.
5. With `users.registration.activate` (default `true`) it activates the account, which runs the `users.activate` hooks and emits `UserActivated`. An error after the account became active is logged, not thrown. A `users.activate` hook that refuses leaves the account inactive and the refusal is rethrown. With `false` the account stays inactive until an administrator calls `activate()`, and it receives no verification mail until then.
6. It answers `{ status: 'created', id }`.

A concurrent registration of the same address makes one account: the loser gets `exists`. If `create()` reports that a later step failed (`UserCreatedIncomplete`), the account exists and counts as created.

## Configuration

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `users.registration.enabled` | boolean | `false` | Provide an `IdentityRegistrar`. |
| `users.registration.activate` | boolean | `true` | Activate the new account at once. `false`: an administrator activates it. |

## Important behaviour

- The factory builds the registrar with `new`, so it does not inject the `Orm`: its lookup needs an `Orm` the app resolved before serving (`OrmMigrator` at boot does).
- Combine it with `authn.login.requireVerifiedAddress: true` to keep an account from signing in before its address is verified.
- `UserLifecycleMailHook` sends the `users.email.created` and `users.email.activated` lifecycle mails after `create()` and `activate()`. Set their `enabled` to `false` if the verification mail is the only one you want.
- How `POST /auth/register` answers a refused `users.create` or `users.activate`: see [Action hooks](04-action-hooks.md#important-behaviour).
