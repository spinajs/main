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

Delete, deactivate and ban end every session of the target and keep it out, which is what `@spinajs/authn-http`'s
forced logout `DELETE /authn/admin/users/:uuid/sessions` does. So they ask what it asks, in this order, before the
account guard and any write: fresh authentication (a login within `authn.freshAuth.maxAgeSeconds`, or the caller's
password in the body field `reauthPassword`; `403 fresh_auth_required`, a wrong password the login failure `401`, a
token or key caller `403 session_required`, an impersonating session `403 impersonating`), then authn's
`CredentialAdminGuard` with the action `sessions` (users': `users:credentials`, the target covered, no protected role;
`403 forbidden`, `protected_role`, `escalation`; without a registered guard every call is refused). users' guard
refuses the caller's own account (`403 forbidden`), so the account guard's self-lockout rule is reached only behind an
application guard that admits it. Activate, unban and restore give access back and ask neither.

A `PATCH /users/:uuid` that changes an `Email` or `Login` also needs fresh authentication, the caller's own account
included: the public password reset goes to that address, so the change could hand the account over, and a stolen
session that is no longer fresh must not move its own address and then reset the password. Fresh authentication is a
login within `authn.freshAuth.maxAgeSeconds`, or the caller's password in the body field `reauthPassword` (`403
fresh_auth_required`, a wrong password the login failure `401`); a token or key caller gets `403 session_required` and
an impersonating session `403 impersonating`. A change of another account also needs authn's `CredentialAdminGuard`
(action `password-reset`), as `@spinajs/authn-http`'s admin password reset does. Both are asked after the input checks
(a reserved login, an empty role list: `400`) and before the account guard, the role dry run, the uniqueness check and
any write. The guard answers as on the session routes below (`403 forbidden`, `protected_role`, `escalation`), and
without a registered guard such a change is refused. A role-only change and an `Email` or `Login` sent unchanged need
only `users:update`. users' guard checks `users:credentials`, which `@spinajs/users` registers and its `admin.users`
role grants through `users:*`.

## Routes

| Method   | Path                                          | Permission     | What it does                                              |
| -------- | --------------------------------------------- | -------------- | --------------------------------------------------------- |
| `GET`    | `/users`                                      | `users:read`   | Paginated, filterable, sortable list. `X-Total-Count` header |
| `GET`    | `/users/roles`                                | `users:read`   | Roles the caller is allowed to assign                     |
| `GET`    | `/users/:uuid`                                | `users:read`   | One account                                               |
| `GET`    | `/users/byLogin/:login`                       | `users:read`   | One account, addressed by login                           |
| `POST`   | `/users`                                      | `users:create` | Create an account ( inactive, no password, invite sent )  |
| `PATCH`  | `/users/:uuid`                                | `users:update` | Partial update of login / email / role                    |
| `DELETE` | `/users/:uuid`                                | `users:delete` + credential admin guard + fresh auth | Soft delete + session revocation |
| `PATCH`  | `/users/:uuid/restore`                        | `users:delete` | Clear `DeletedAt`                                         |
| `GET`    | `/users/profile/:login`                       | `users:read`   | Profile through the configured `UserProfileProvider`      |
| `POST`   | `/users/security/activate/:uuid`              | `users:update` | Activate the account                                      |
| `POST`   | `/users/security/deactivate/:uuid`            | `users:delete` + credential admin guard + fresh auth | Deactivate + revoke sessions |
| `POST`   | `/users/security/ban/:uuid`                   | `users:delete` + credential admin guard + fresh auth | Ban for `duration` seconds + revoke sessions |
| `POST`   | `/users/security/unban/:uuid`                 | `users:update` | Lift a ban                                                |
| `GET`    | `/users/security/sessions/:uuid`              | `users:read` + credential admin guard | The user's live sessions, newest first, by handle |
| `DELETE` | `/users/security/sessions/:uuid/:handle`      | `users:update` + credential admin guard + fresh auth | End one session of the user |

## Routes of the signed-in user and metadata

| Method   | Path                                   | Permission              | What it does                                              |
| -------- | -------------------------------------- | ----------------------- | --------------------------------------------------------- |
| `GET`    | `/user`                                | `user:read` (own row)   | The caller's record with its metadata, limited to the fields its roles read |
| `GET`    | `/user/tokens/roles`                   | `user:read` (own row)   | Roles a new token may carry (see below)                   |
| `GET`    | `/user/tokens/profiles`                | `user:read` (own row)   | Profiles a new token may be pinned to                     |
| `GET`    | `/user/metadata`, `/user/metadata/:key` | `user.metadata:read`    | The caller's own metadata, paginated / one entry          |
| `POST`   | `/user/metadata`                       | `user.metadata:create`  | Add an entry (an existing key is an update)               |
| `PATCH`  | `/user/metadata/:id`                   | `user.metadata:update`  | Update an entry                                           |
| `DELETE` | `/user/metadata/:id`                   | `user.metadata:delete`  | Delete an entry                                           |
| `GET`, `POST`, `PATCH`, `DELETE` | `/user/:uuid/metadata[/...]` | the same, per row | The metadata of another user                              |

`/user` and the token routes answer 403 to a service, agent or other non-user principal. The metadata permissions are
decided on each entry's row: users' `user` role holds them with the `owner` relation (its own entries only), `admin.users`
unconditionally. Reserved keys (credential state such as `2fa:token`) are never listed; a read, update or delete of one
answers 404 as for a missing entry, and a write of one is refused.

## Sessions of a user

The two session routes read and end the sessions of authn's `SessionIssuer`. Besides `@Access` (decided on the
addressed row), they need what `@spinajs/authn-http`'s credential admin routes need:

- a caller signed in with a session: a token, key or signature caller gets `403 session_required`, an impersonating
  session `403 impersonating`;
- authn's `CredentialAdminGuard` (action `sessions`) answering `ok: true`. users' `AuthzCredentialAdminGuard` wants
  `authz.credentials.permission` (default `users:credentials`) at GLOBAL, a target whose rights the caller's strictly
  contain and no protected role on the target; it refuses the caller's own account, whose sessions the owner routes
  (`GET /user/sessions`, `DELETE /user/sessions/:handle`) manage. A refusal answers `403` with `forbidden`,
  `protected_role` or `escalation`; without a registered guard every call is refused (`403 forbidden`);
- for the revoke, fresh authentication: a login within `authn.freshAuth.maxAgeSeconds`, or the caller's password in the
  body field `reauthPassword` (`403 fresh_auth_required`, a wrong password the login failure `401`).

`@spinajs/users` registers `users:credentials`; its `admin.users` role (and `admin`, which extends it) holds it
through `users:*`. A list entry carries `Handle` (the issuer's
one-way handle, never the session id), `Created`, `LastSeen` and, when stored, `Ip` and `UserAgent`, so an
administrator can tell the devices apart before ending one. A handle that is not one of this user's sessions answers
`404 session_not_found`. Answers carry `Cache-Control: no-store`. An ended session is audited as `session.revoke`
(reason `admin`, the caller as actor, the handle).

`@spinajs/authn-http` serves four admin routes under `/authn/admin/users/:uuid`: `POST password-reset` (sends the reset),
`POST mfa-reset`, `DELETE sessions` (ends every session of the user, impersonations included) and `DELETE tokens`
(revokes every token of the user). 3.0 has no admin route to set a password, expire one or enable two-factor (the owner
enrols), and no login lockout to clear (authn throttles instead), so `unlock` is gone.

The admin routes do not manage user metadata. `UserMetadataController` serves `/user/:uuid/metadata`, which validates one entry at
a time. Another user's metadata needs an unconditional `user.metadata` grant (users' `admin.users`); users' `user` role
reaches only its own, through the `owner` relation.

## Token roles and profiles of the signed-in user

`GET /user/tokens/roles` answers `{ Roles }` and `GET /user/tokens/profiles` answers `{ Profiles }`: what a picker may
offer for `@spinajs/authn-http`'s `POST /user/tokens`, which they never exceed. Both sit on `@Access('user:read')`
decided on the caller's own row, and serve the callers that route serves: a token or key caller gets
`403 session_required`, an impersonating session `403 impersonating`. They answer `404` while no `TokenService` is
registered, and carry `Cache-Control: no-store`.

- Roles: those the create route accepts (each held by the caller at any scope, by authn's `RoleSource`), less those a
  token loses at check time: `authz.token.excludedRoles` and `authz.token.rolePolicy` of the access domain
  (`authz.http.access.domain`). `?profile=<role>` gives those of a token pinned to that profile, and none for a profile
  the create route refuses; a malformed `profile` answers `400`.
- Profiles: authn-token's `TokenProfilePolicy`; none while no such policy is registered (authn-token's default offers
  none). authz-rbac's `TokenRolePolicy.allowedProfiles` is not read: no create or check path reads it.
- A policy that fails or answers anything but a list of role names answers `500`; nothing is offered.

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

Delete, deactivate and ban are not AuthzAdmin commands. After fresh authentication and the credential admin guard
(see the top of this file) they go through the
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
- 3.0: the exports `ChangePasswordDto`, `PasswordDto` and the `'expire-password'` action are gone with their routes.
- 3.0: `GET /user/refresh` is `GET /user`; `GET /user/grants` (see `GET /user/access` of `@spinajs/authz-http`) and
  `PATCH /user/password` (`@spinajs/authn-http`) answer 404.
- 3.0: the forced logout `DELETE /users/security/sessions/:uuid` is gone (404). Clients call
  `DELETE /authn/admin/users/:uuid/sessions` of `@spinajs/authn-http`, which answers `{ revoked }` (the count)
  and needs `users:credentials` and fresh authentication.
- 3.0: the session list and the per-handle revoke read the 3.0 `SessionIssuer` and need a session caller and the
  credential admin guard (see "Sessions of a user"); the revoke also needs fresh authentication. A list entry is
  `{ Handle, Created, LastSeen, Ip?, UserAgent? }` (`IAdminSessionEntry`); `Expires` is gone.
- 3.0: changing an `Email` or `Login` through `PATCH /users/:uuid` needs fresh authentication besides
  `users:update`, the caller's own account included; the body takes `reauthPassword` for that. A change of another
  account also needs the credential admin guard (`users:credentials`, the target covered, no protected role).
- 3.0: `DELETE /users/:uuid`, `POST /users/security/deactivate/:uuid` and `POST /users/security/ban/:uuid` need
  fresh authentication (the body takes `reauthPassword`) and the credential admin guard (action `sessions`:
  `users:credentials`, the target covered, no protected role) besides `users:delete`. A `users:delete` holder can no
  longer disable an administrator it does not cover, and under users' guard nobody disables their own account
  through them, whatever `preventSelfLockout` says.
- 3.0: `users:*` covers `users:credentials`, which the credential admin guard asks. A role manager holding single
  `users:<action>` grants without `users:credentials` can no longer hand out `admin.users`.
- `activate` and `deactivate` moved off `GET`. They are now `POST /users/security/activate/:uuid` and
  `POST /users/security/deactivate/:uuid`.
- `activate` now requires `updateAny` instead of `deleteAny`.
- `GET /users/:uuid` and `GET /users/byLogin/:login` now require `readAny`. They previously required
  nothing beyond a valid session — any authenticated account could read any other.
- `PATCH /users/:uuid` no longer accepts `Metadata`, and its body is validated as a partial update
  ( `Login`, `Email`, `Role` are all optional, unknown properties are rejected ).
- Credential-bearing metadata ( password-reset token, 2FA secret, ban and lockout state ) is filtered
  out of every dehydrated user, in this package and everywhere else.
