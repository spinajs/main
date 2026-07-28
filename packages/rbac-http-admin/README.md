# `@spinajs/rbac-http-admin`

Administrative HTTP API for user accounts: listing and editing users, roles, passwords, two-factor
authentication, bans, login lockouts and live sessions.

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
| `POST`   | `/users`                                      | `createAny` | Create an account ( inactive, temporary password discarded ) |
| `PATCH`  | `/users/:uuid`                                | `updateAny` | Partial update of login / email / role                    |
| `DELETE` | `/users/:uuid`                                | `deleteAny` | Soft delete + session revocation                          |
| `PATCH`  | `/users/:uuid/restore`                        | `deleteAny` | Clear `DeletedAt`                                         |
| `PATCH`  | `/users/role/add/:login`                      | `updateAny` | Grant a role                                              |
| `PATCH`  | `/users/role/revoke/:login`                   | `updateAny` | Revoke a role                                             |
| `GET`    | `/users/profile/:login`                       | `readAny`   | Profile through the configured `UserProfileProvider`      |
| `PATCH`  | `/users/security/changePassword/:uuid`        | `updateAny` | Set a password. Revokes every session of that user        |
| `POST`   | `/users/security/password-reset-request/:uuid`| `updateAny` | Issue a reset token and emit `UserPasswordChangeRequest`  |
| `POST`   | `/users/security/expire-password/:uuid`       | `deleteAny` | Expire the password ( deactivates the account )           |
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

User metadata is NOT managed here — `@spinajs/rbac-http-user` owns `/user/:uuid/metadata`, which
validates one entry at a time.

## Handing a new account to its owner

`POST /users` creates the account **inactive** and throws the generated temporary password away, so a
created account cannot be logged into yet. The intended flow is:

1. `POST /users`
2. `POST /users/security/password-reset-request/:uuid` — the application delivers the token by
   hooking `UserPasswordChangeRequest`
3. the user sets their own password through `POST /auth/password/reset`
4. `POST /users/security/activate/:uuid`

## Role guard

Role changes are the one operation in this API that can grant MORE than the caller holds, so they run
through a `RoleGuard` service first. Configure it under `rbac.admin.roleGuard`:

```js
rbac: {
  admin: {
    roleGuard: {
      service: 'DefaultRoleGuard',

      // reject role names not declared in rbac.grants / rbac.roles
      requireKnownRole: true,
      // rbac.systemRole is never assignable or revocable over HTTP
      protectSystemRole: true,
      // a role whose grants exceed the caller's cannot be handed out
      preventEscalation: true,
      // no self-deactivation, self-deletion, self-ban, self-demotion
      preventSelfLockout: true,
      // never empty a privileged role of its last active holder
      preventLastPrivilegedRemoval: true,

      // what counts as "privileged" for the two checks above
      privilegedResource: 'users',
      privilegedAction: 'update:any',
    },
  },
}
```

Replace the whole policy by registering your own class under the `RoleGuard` base and naming it in
`service`:

```ts
@Injectable(RoleGuard)
export class MyRoleGuard extends RoleGuard { /* ... */ }
```

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
