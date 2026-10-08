# `@spinajs/users-http`

HTTP API for user accounts: the signed-in user's profile (`GET /user`, on `@Access('user:read')`) and metadata routes (on `@Access('user.metadata:<action>')`), and an administrative API for
listing and editing users, roles, passwords, two-factor authentication, bans, login lockouts and live sessions.

Every route sits behind `AuthorizedPolicy` plus a route-level `@Permission` on the `users` resource,
so an application grants access with ordinary rbac grants:

```js
grants: {
  admin: {
    users: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
  },
}
```

## Routes

| Method   | Path                                          | Permission  | What it does                                              |
| -------- | --------------------------------------------- | ----------- | --------------------------------------------------------- |
| `GET`    | `/users`                                      | `readAny`   | Paginated, filterable, sortable list. `X-Total-Count` header |
| `GET`    | `/users/roles`                                | `readAny`   | Roles the caller is allowed to assign                     |
| `GET`    | `/users/:uuid`                                | `readAny`   | One account                                               |
| `GET`    | `/users/byLogin/:login`                       | `readAny`   | One account, addressed by login                           |
| `POST`   | `/users`                                      | `createAny` | Create an account ( inactive, no password, invite sent )  |
| `PATCH`  | `/users/:uuid`                                | `updateAny` | Partial update of login / email / role                    |
| `DELETE` | `/users/:uuid`                                | `deleteAny` | Soft delete + session revocation                          |
| `PATCH`  | `/users/:uuid/restore`                        | `deleteAny` | Clear `DeletedAt`                                         |
| `GET`    | `/users/profile/:login`                       | `readAny`   | Profile through the configured `UserProfileProvider`      |
| `PATCH`  | `/users/security/changePassword/:uuid`        | `updateAny` | Set a password. Revokes every session of that user        |
| `POST`   | `/users/security/password-reset-request/:uuid`| `updateAny` | Issue a reset token and emit `UserPasswordChangeRequest`  |
| `POST`   | `/users/security/expire-password/:uuid`       | `deleteAny` | Expire the password ( the account stays active )          |
| `PATCH`  | `/users/security/reset2fa/:uuid`              | `updateAny` | Clear the TOTP secret                                     |
| `POST`   | `/users/security/2fa/enable/:uuid`            | `updateAny` | Enrol 2FA, returns the enrolment url                      |
| `POST`   | `/users/security/2fa/disable/:uuid`           | `updateAny` | Turn 2FA off                                              |
| `POST`   | `/users/security/activate/:uuid`              | `updateAny` | Activate the account                                      |
| `POST`   | `/users/security/deactivate/:uuid`            | `deleteAny` | Deactivate + revoke sessions                              |
| `POST`   | `/users/security/ban/:uuid`                   | `deleteAny` | Ban for `duration` seconds + revoke sessions              |
| `POST`   | `/users/security/unban/:uuid`                 | `updateAny` | Lift a ban                                                |
| `POST`   | `/users/security/unlock/:uuid`                | `updateAny` | Clear a login-throttle lockout                            |
| `GET`    | `/users/security/sessions/:uuid`              | `readAny`   | Live sessions, by opaque handle                           |
| `DELETE` | `/users/security/sessions/:uuid/:handle`      | `updateAny` | Revoke one session                                        |
| `DELETE` | `/users/security/sessions/:uuid`              | `updateAny` | Revoke every session of the user                          |

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

Delete, deactivate, ban and password expiry are not AuthzAdmin commands. They go through the
`AccountGuard` service (`DefaultAccountGuard`), which reads the same `authz.admin.guard` switches.
A `PATCH` that removes a role goes through it too (`assertCanDemote`): AuthzAdmin's last-holder rule
counts deactivated, banned and deleted holders, the account guard counts only active ones.

```js
authz: {
  admin: {
    guard: {
      // no self-deactivation, self-deletion, self-ban, own password expiry
      preventSelfLockout: true,
      // never take the last active account holding privilegedPermission out of service
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
