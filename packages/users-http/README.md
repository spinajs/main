# `@spinajs/users-http`

HTTP API for user accounts: the signed-in user's profile (`GET /user`, on `@Access('user:read')`) and metadata routes (on `@Access('user.metadata:<action>')`), and an administrative API for
listing and editing users, their roles, activation and bans.

Every route sits on `@Access(...)` from `@spinajs/authz-http`. The admin routes check `users:read`, `users:create`,
`users:update` or `users:delete` on the `users` type, so an application grants them with ordinary role grants
(users' `admin.users` role holds `users:*`):

```js
authz: {
  rbac: {
    roles: {
      'user-admin': { grants: ['users:read', 'users:create', 'users:update', 'users:delete'] },
    },
  },
}
```

A conditional grant (for example `{ permission: 'users:update', relation: 'self' }`) never reaches another user's
record: `GET`, `PATCH` and `DELETE` of one user decide it again on that user's row, and the list, create, restore and
the lifecycle routes (activate, deactivate, ban, unban) need a grant on every user. The routes that act through
AuthzAdmin or the account guard (create, update, delete, deactivate, ban, assignable roles) need a signed-in user as the
caller; a service principal is refused there.

## Routes

| Method   | Path                                          | Permission     | What it does                                              |
| -------- | --------------------------------------------- | -------------- | --------------------------------------------------------- |
| `GET`    | `/users`                                      | `users:read`   | Paginated, filterable, sortable list. `X-Total-Count` header |
| `GET`    | `/users/roles`                                | `users:read`   | Roles the caller is allowed to assign                     |
| `GET`    | `/users/:uuid`                                | `users:read`   | One account                                               |
| `GET`    | `/users/byLogin/:login`                       | `users:read`   | One account, addressed by login                           |
| `POST`   | `/users`                                      | `users:create` | Create an account ( inactive, no password, invite sent )  |
| `PATCH`  | `/users/:uuid`                                | `users:update` | Partial update of login / email / role                    |
| `DELETE` | `/users/:uuid`                                | `users:delete` | Soft delete + session revocation                          |
| `PATCH`  | `/users/:uuid/restore`                        | `users:delete` | Clear `DeletedAt`                                         |
| `GET`    | `/users/profile/:login`                       | `users:read`   | Profile through the configured `UserProfileProvider`      |
| `POST`   | `/users/security/activate/:uuid`              | `users:update` | Activate the account                                      |
| `POST`   | `/users/security/deactivate/:uuid`            | `users:delete` | Deactivate + revoke sessions                              |
| `POST`   | `/users/security/ban/:uuid`                   | `users:delete` | Ban for `duration` seconds + revoke sessions              |
| `POST`   | `/users/security/unban/:uuid`                 | `users:update` | Lift a ban                                                |
| `GET`    | `/users/security/sessions/:uuid`              | `users:read`   | Not served yet (answers 500): moves onto the 3.0 session issuer |
| `DELETE` | `/users/security/sessions/:uuid/:handle`      | `users:update` | Not served yet (answers 500): moves onto the 3.0 session issuer |
| `DELETE` | `/users/security/sessions/:uuid`              | `users:update` | Not served yet (answers 500): moves onto the 3.0 session issuer |

Password, reset, password expiry and two-factor administration are served by `@spinajs/authn-http` under
`/authn/admin/users/:uuid/*`. 3.0 has no login lockout to clear (authn throttles instead), so `unlock` is gone.

The admin routes do not manage user metadata. `UserMetadataController` serves `/user/:uuid/metadata`, which validates one entry at
a time. Another user's metadata needs an unconditional `user.metadata` grant (users' `admin.users`); users' `user` role
reaches only its own, through the `owner` relation.

## Handing a new account to its owner

`POST /users` creates the account **inactive** and without a password: `create()` sends the owner an
invite through authn's `PasswordService`. The owner sets a password by redeeming it, which activates
the account. When a step after the role grants fails, the account exists anyway: the answer is still
`200` with the account and `Incomplete: { resendInvite }`, telling whether to send the invite again.

## Role changes and the account guard

Roles are GLOBAL assignments of `user:<Uuid>`. `POST /users`, `PATCH /users/:uuid` (whose `Role` replaces
the account's GLOBAL roles) and `GET /users/roles` go through `AuthzAdmin` with the caller as actor, so
authz-rbac's `AdminGuard` (`authz.admin.guard`) refuses escalation, non-assignable roles, self lockout
and removing the last holder of `privilegedPermission`. A refusal answers `403` (`escalation`,
`protected_role`, `forbidden`, `self_lockout`, `last_holder`) or `400` (`unknown_role`,
`not_assignable`, `wrong_scope_type`). A request without a caller is refused, never run as SYSTEM.
The `Role` list filter matches the GLOBAL holders of the named roles; `Role` is not sortable.

Delete, deactivate and ban are not AuthzAdmin commands. They go through the
`AccountGuard` service (`DefaultAccountGuard`), which reads the same `authz.admin.guard` switches.
A `PATCH` that removes a role goes through it too (`assertCanDemote`), before AuthzAdmin sees the batch.

The account guard counts another holder of `privilegedPermission` as a witness only when the registered
`AccountStatusSource` (users' `UserAccountStatusSource`) answers `true` for it and its row is active,
unbanned and undeleted. An account with an expired password or a pending invite is no witness. A source
that is missing, throws or answers anything but a `Map` with `true` counts no witness, so the last
privileged account stays. The target itself counts as privileged while its row is active, unbanned and
undeleted, whatever the source says: a password reset or an accepted invite can still bring it back.
The guard never asks the source about the target. It searches role by role, asks about at most 100
holders per call and tries only the first in-service holder of each role, so a role every account
holds usually costs one call.

```js
authz: {
  admin: {
    guard: {
      // no self-deactivation, self-deletion, self-ban
      preventSelfLockout: true,
      // never take the last account in service holding privilegedPermission out of service
      preventLastPrivilegedRemoval: true,
      privilegedPermission: 'users:update',
    },
  },
}
```

An absent switch is on. Replace the policy by registering your own class under the `AccountGuard` base:

```ts
@Injectable(AccountGuard)
export class MyAccountGuard extends AccountGuard { /* ... */ }
```

This package's config fragment declares the `users:read`, `users:create`, `users:update` and
`users:delete` permissions.

## Breaking changes in this release

- 3.0: the admin routes sit on `@Access('users:<action>')` instead of `AuthorizedPolicy` + `@Permission`;
  `readOwn`/`updateOwn`-style grants become conditional grants decided on the addressed row.
- 3.0: `changePassword`, `password-reset-request`, `expire-password`, `reset2fa`, `2fa/enable`, `2fa/disable`
  and `unlock` under `/users/security` are gone (404); the credential routes live in `@spinajs/authn-http`.
- 3.0: the admin session routes answer 500 until they move onto the 3.0 session issuer.
- `activate`, `deactivate` and the forced logout moved off `GET`. They are now
  `POST /users/security/activate/:uuid`, `POST /users/security/deactivate/:uuid` and
  `DELETE /users/security/sessions/:uuid`.
- `activate` now requires `updateAny` instead of `deleteAny`.
- `GET /users/:uuid` and `GET /users/byLogin/:login` now require `readAny`. They previously required
  nothing beyond a valid session — any authenticated account could read any other.
- `PATCH /users/:uuid` no longer accepts `Metadata`, and its body is validated as a partial update
  ( `Login`, `Email`, `Role` are all optional, unknown properties are rejected ).
- Credential-bearing metadata ( password-reset token, 2FA secret, ban and lockout state ) is filtered
  out of every dehydrated user, in this package and everywhere else.
