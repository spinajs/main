# User actions

Functions that change account state: create, activate, deactivate, ban, unban, delete, expire a password. Each one writes the row, ends sessions and tokens where the account may no longer act, emits its [event](06-user-events.md) and sends its [mail](05-lifecycle-mails.md). Call these instead of writing `User` fields yourself.

Every action that takes `identifier` accepts a numeric id, a UUID, an email, a login, or a `User` instance.

## How it works

### `create(data, roles?, actor = SYSTEM)`

1. Validates `data.Email` (trimmed, an email, at most 64 characters) and `data.Login` (trimmed, at most 32 characters, not a [reserved login](01-user-model.md#reserved-keys-logins-and-markers)). Failures throw `InvalidArgument`.
2. Picks the roles: `roleList(roles)`; when that is empty, `authz.rbac.defaultRoles` (see [Default roles](12-default-roles.md)).
3. Resolves `PasswordService` (authn-local's `LocalPasswordService` by default). None registered throws `InvalidOption`.
4. With `data.Password`, runs `PasswordService.check()`. A failed policy throws `InvalidArgument('Password does not meet requirements', 'password', 'E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS')`.
5. `assertNoProtectedMetadata(data.Metadata)` and `assertUserUnique(login, email)`.
6. Generates the UUID and dry-runs the role grants through `AuthzAdmin` (validated and guarded, then rolled back). A role `AuthzAdmin` refuses (`unknown_role`, `not_assignable`, `wrong_scope_type`) throws `InvalidArgument` on field `roles`; any other refusal throws the `AuthzAdminFailure`.
7. Builds `new User({ ..., Password: NO_PASSWORD, IsActive: false, RegisteredAt: now })` and runs the `beforeCreate` [middleware](04-create-middleware.md).
8. Inserts the row.
9. With a password: `PasswordService.set(user:<Uuid>, password, ctx, { actor })`. Without one: stores `user:invite:pending = true`.
10. Grants the roles at GLOBAL through `AuthzAdmin`, as `actor`.
11. If step 9 or 10 fails, the row and its metadata are hard-deleted and the error is rethrown.
12. Writes `data.Metadata` (`setUserMeta`), runs the `afterCreate` middleware, emits `UserCreated` (with the granted roles).
13. Without a password: `PasswordService.invite()` sends the invite through authn-local's `PasswordMailer`. With one: sends the `created` mail.
14. If step 12 or 13 fails, the account stays. It throws `UserCreatedIncomplete` with `data: { user: <Uuid>, resendInvite, error: <error class> }`.
15. Resolves `{ User }`. It never returns a password.

### The other actions

| Action | Steps | Event, mail |
| --- | --- | --- |
| `activate(identifier)` | Drop `user:invite:pending`; on an inactive account `IsActive = true` (`updateUser`) | `UserChanged`, `UserActivated`; mail `activated`. None on an already active account |
| `deactivate(identifier)` | Drop `user:invite:pending`, write `IsActive = false` unconditionally, `revokeUserSessions`, `revokeUserTokens` | `UserChanged`, `UserDeactivated`; mail `deactivated` |
| `ban(identifier, reason = 'NO_REASON', duration = 86400)` | Refuse with `UserIsBanned` when `IsBanned`; write the four `user:ban:*` keys (duration in seconds); revoke sessions and tokens | `UserMetadataChange`, `UserBanned`; mail `banned` |
| `unban(identifier)` | Refuse with `UserIsBanned` when `user:ban:is_banned` is not set; delete the four `user:ban:*` keys | `UserUnbanned`; mail `unbanned` |
| `deleteUser(identifier)` | Soft delete (`destroy()`), revoke sessions and tokens | `UserDeleted`; mail `deleted` |
| `expirePassword(identifier, actor = SYSTEM)` | `PasswordService.expire(user:<Uuid>, { cause: 'admin', actor })`: stores `'!expired'`, ends authn sessions and, under `authn.local.reset.revokeTokens`, API tokens. The account stays active. | `UserPasswordExpired` (through [`QueueAuthnEventSink`](08-authn-event-sinks.md)); mail `passwordExpired` |
| `notifyPasswordWillExpire(identifier, expiresAt?)` | Nothing changes | mail `passwordWillExpire` with `ExpiresAt` in the model |
| `updateUser(user, data?)` | `updateModel(user, data)` | `UserChanged` |

`revokeUserSessions(user)` calls `SessionIssuer.revokeAll(user:<Uuid>, { includeImpersonations: true })` and `revokeUserTokens(user)` calls `TokenService.revokeAllFor(user:<Uuid>, ...)`, each only when the service is registered. Both accept a `User` or a numeric id (soft-deleted rows included) and let errors propagate.

## Helper API

| Function | Meaning |
| --- | --- |
| `getUser(identifier)` | The user through `userModel()`, `Metadata` populated; a `User` instance is returned as is. Rejects when not found. |
| `getUserUnsafe(identifier)` | Same through `UserBase`: reads any row, no authz scoping. |
| `getUsersByRole(roles)` | Users holding any of the roles as a live GLOBAL assignment (`AssignmentStore.holders`); subject sets not expanded, soft-deleted users excluded. Throws `AuthzConfigError` when no `AssignmentStore` is registered. |
| `setUserMeta(user, key, value)` / `setUserMeta(user, [{ key, value }])` | Writes metadata, refuses reserved keys and globs, emits `UserMetadataChange`. `Metadata` must be populated. |
| `getUserMeta(user, key)` | The value; throws `MetadataNotPopulated` or `MetadataNotFound`. |
| `sendUserEmail(user, template, model?)` | Queues a lifecycle mail; see [Lifecycle mails](05-lifecycle-mails.md). |
| `roleList(role?)` | One name or a list, trimmed, blanks dropped, de-duplicated, order kept. |
| `rootAuthzAdmin()` | The `AuthzAdmin` of the root container's `AuthzService`, the one `create()` grants roles through. |
| `assertNoProtectedMetadata(metadata?)` | Throws `InvalidArgument` for a reserved key or a key containing `*` or `?`. |
| `assertUserUnique(login?, email?, exceptUserId?)` | Throws `UserAlreadyExists` with `data.fields` (`['Login']`, `['Email']` or both) when another account, soft-deleted ones included, holds the value in any case or width variant. Also refuses reserved logins. |
| `assertLoginNotReserved(login)` | Throws `InvalidArgument` on field `login` for a `__name__` login. |

Function-pipeline forms return a thunk or a chain step: `_user`, `_user_unsafe`, `_get_user` (no metadata), `_get_users_by_role`, `_set_user_meta`, `_get_user_meta`, `_user_email`, `_user_ev(EventClass, ...args)`, `_user_update`.

### Types

| Type | Shape |
| --- | --- |
| `ICreateUserData` | `Email`, `Login`, `Password?` (plain text; omit to invite), `Id?` (explicit id, for migrations), `Metadata?` |
| `ICreateUserResult` | `{ User: User }` |
| `CreateMiddleware` | `(u: User) => Promise<User> \| User` |

## Exceptions

All extend `RbacException` (`data` carries a transport-agnostic payload).

| Exception | Thrown when |
| --- | --- |
| `AuthenticationException` | Base of the login failures below. |
| `InvalidCredentials` | Login failed for a reason other than ban or inactivity (used in `UserLoginFailed`). |
| `UserIsBanned` | Banning a banned user, unbanning one that is not banned, building a principal of a banned user. |
| `UserNotActive` | Building a principal of an inactive user. |
| `UserAlreadyExists` | `assertUserUnique()`; `data.fields` names the clashing fields. |
| `UserCreatedIncomplete` | `create()` failed after the grants; `data: { user, resendInvite, error }`. |
| `MetadataNotPopulated` | Metadata read or written before `populate('Metadata')`. |
| `MetadataNotFound` | `getUserMeta()` for a missing key. |
| `EmailTemplateNotConfigured` | `users.email.<template>` is missing. |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.rbac.defaultRoles` | `string[]` | unset (no roles) | assignable role names | Roles `create()` grants when it is given none. |
| `users.actions.create.beforeCreate` | `CreateMiddleware[]` | `[]` | functions | See [Create middleware](04-create-middleware.md). |
| `users.actions.create.afterCreate` | `CreateMiddleware[]` | `[]` | functions | See [Create middleware](04-create-middleware.md). |
| `users.email.*` | object | see [Lifecycle mails](05-lifecycle-mails.md) | | The mail each action sends. |

## Services and extension points

The actions are plain functions; they extend through the services they resolve.

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Password handling | `PasswordService` (`@spinajs/authn/contracts`), resolved per call | authn-local's `LocalPasswordService` | your `PasswordService` | `DI.register(MyPasswordService).as(PasswordService)` after importing users; last registration wins. |
| Role grants | `AuthzService.admin()` of the root domain | authz's `DefaultAuthzAdmin` | | Configure through authz; pass the calling principal as `actor` so its guard runs. |
| Session revocation | `SessionIssuer`, resolved when registered | authn-session's issuer | none: no sessions to end | Register a `SessionIssuer`. |
| Token revocation | `TokenService`, resolved when registered | authn-token's service | none: no tokens to end | Register a `TokenService`. |
| Model class | `RBAC_USER_MODEL` | `User` | your subclass | See [Custom user model](02-custom-user-model.md). |
| Create hooks | `users.actions.create.*` | none | | See [Create middleware](04-create-middleware.md). |

### Compose your own action

Build an action from the exported pieces so it keeps the events, mails and revocations of the shipped ones. This one suspends an account for fraud review: ban plus deactivate in one call.

```ts sample
import { ban, deactivate, getUser, revokeUserSessions, revokeUserTokens } from '@spinajs/users';
import type { User } from '@spinajs/users';

export async function suspendForFraudReview(identifier: string, caseId: string): Promise<User> {
  const user = await getUser(identifier);

  try {
    await ban(user, `fraud review ${caseId}`, 14 * 24 * 60 * 60);
    return await deactivate(user);
  } catch (err) {
    // The ban or deactivation is stored before revocation runs; finish it so no session survives.
    await revokeUserSessions(user);
    await revokeUserTokens(user);
    throw err;
  }
}
```

## Important behaviour

- `create()` makes the account **inactive** (`IsActive = false`), with or without a password. Activate it with `activate()`, a `beforeCreate` middleware, or the invite redeem (which activates invite-pending accounts, see [Authn event sinks](08-authn-event-sinks.md)).
- `create()` sends no users mail for an invited account; authn-local's `PasswordMailer` sends the invite at once, never through the queue.
- `create()` as `SYSTEM` skips `AuthzAdmin`'s guard. A caller acting for a user must pass that user's principal as `actor`, or it can grant roles above its own.
- A revocation failure in `ban`, `deactivate` or `deleteUser` throws **after** the state change is stored. Call `revokeUserSessions` and `revokeUserTokens` again to finish.
- `activate()` on an already active account only drops `user:invite:pending`: no event, no mail.
- `ban()` refuses a banned user only while the ban runs; an expired ban can be replaced. `unban()` refuses when the flag is absent, even if an old ban expired.
- `deleteUser()` is a soft delete. The login and email stay taken: `assertUserUnique()` counts soft-deleted rows.
- `revokeUserTokens()` names the ambient principal as the audit actor; an unattended or anonymous caller is named as nobody.

## Best practices

- Pass `actor` to `create()` and `expirePassword()` from HTTP and CLI callers that act for someone.
- Handle `UserCreatedIncomplete` by reading `data.resendInvite`: when `true`, call `PasswordService.invite()` for `data.user`.
- Use `setUserMeta()` for application metadata; it refuses keys that would hand out an account.
- Schedule `notifyPasswordWillExpire()` ahead of authn-local's expiration job; it changes nothing by itself.

## Patterns and antipatterns

```ts
// Don't: writing the ban keys directly skips the event, the mail and the session revocation
user.Metadata['user:ban:is_banned'] = true;
await user.Metadata.update();

// Do
await ban(user, 'abusive messages', 7 * 24 * 60 * 60);
```

```ts
// Don't: an HTTP handler creating users as SYSTEM lets any caller grant any role
await create({ Email, Login }, req.body.roles);

// Do: the caller's principal goes to AuthzAdmin's guard
await create({ Email, Login }, req.body.roles, callerPrincipal);
```

## Examples

### Invite a new employee

```ts sample
import { UserCreatedIncomplete, create } from '@spinajs/users';
import type { Principal } from '@spinajs/authz';

export async function inviteEmployee(email: string, login: string, invitedBy: Principal): Promise<string> {
  try {
    // No password: the account is marked invite-pending and PasswordService.invite() mails the link.
    const { User: user } = await create({ Email: email, Login: login, Metadata: { 'hr:department': 'sales' } }, ['user'], invitedBy);
    return user.Uuid;
  } catch (err) {
    if (err instanceof UserCreatedIncomplete && err.data.resendInvite) {
      // The account exists; retry only the invite later for err.data.user.
      return err.data.user;
    }
    throw err;
  }
}
```

### Rename a user with the same uniqueness rule as `create()`

```ts sample
import { assertUserUnique, getUser, updateUser } from '@spinajs/users';

export async function renameUser(uuid: string, login: string): Promise<void> {
  const user = await getUser(uuid);

  await assertUserUnique(login, undefined, user.Id);
  await updateUser(user, { Login: login });
}
```

## Related

- [Create middleware](04-create-middleware.md): change the user while `create()` runs.
- [Lifecycle mails](05-lifecycle-mails.md): what each action sends.
- [User events](06-user-events.md): what each action emits.
- [Default roles](12-default-roles.md): the roles `create()` grants by default.
- [`@spinajs/authn`](../authn/README.md): `PasswordService`, `SessionIssuer`, `TokenService`.
