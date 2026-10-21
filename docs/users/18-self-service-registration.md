# Self-service registration

`UserIdentityRegistrar` is the `IdentityRegistrar` of `@spinajs/users`: it creates an account for a stranger through [`create()`](03-user-actions.md). [`POST /auth/register`](../authn-http/22-registration-route.md) of `@spinajs/authn-http` calls it. It is off by default.

## How it works

1. `RbacBootstrapper` registers a factory for `IdentityRegistrar`. The factory yields a `UserIdentityRegistrar` while `users.registration.enabled` is `true` and nothing otherwise, so the registration route answers 404 until you switch it on.
2. `register({ login, email, password }, ctx)` refuses a reserved login (`__name__`) with `InvalidArgument` first.
3. It looks for an account that holds the email or the login, soft-deleted ones included, an exact email match first. A taken address answers `{ status: 'exists', id }` and writes nothing. It hashes the password once on this path, so a taken address costs what a new account costs.
4. Otherwise it calls `create({ Email, Login, Password })` as `SYSTEM`. `create()` checks the password policy again, grants `authz.rbac.defaultRoles`, sets the password through `PasswordService.set` and sends the `created` lifecycle mail. The account has no verified address yet.
5. With `users.registration.activate` (default `true`) it activates the account, which emits `UserActivated`. A failing `activated` mail does not undo that. With `false` the account stays inactive until an administrator calls `activate()`, and it receives no verification mail until then.
6. It answers `{ status: 'created', id }`.

A concurrent registration of the same address makes one account: the loser gets `exists`. If `create()` reports that a later step failed (`UserCreatedIncomplete`), the account exists and counts as created.

## Configuration

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `users.registration.enabled` | boolean | `false` | Provide an `IdentityRegistrar`. |
| `users.registration.activate` | boolean | `true` | Activate the new account at once. `false`: an administrator activates it. |

## Important behaviour

- Combine it with `authn.login.requireVerifiedAddress: true` to keep an account from signing in before its address is verified.
- `create()` and `activate()` still send the `users.email.created` and `users.email.activated` lifecycle mails. Set their `enabled` to `false` if the verification mail is the only one you want.
