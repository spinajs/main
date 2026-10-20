# `@spinajs/users-http`

HTTP API for user accounts: the signed-in user's own record and metadata, and an administrative API for listing, creating, editing, disabling and banning users and ending their sessions. Every route sits on `@Access(...)` from `@spinajs/authz-http`, and every service it calls is a DI registration you can replace.

It does **not** log users in, set passwords or run two-factor: those routes live in `@spinajs/authn-http`. It does **not** store users either: models, actions (`create`, `ban`, `deactivate`, ...) and roles come from `@spinajs/users`.

## Install

```sh
npm install @spinajs/users-http
```

Installing is enough. The package's config fragment adds its controller directories to `system.dirs.controllers`, so the file scan of `@spinajs/http` mounts the routes; importing a controller file registers the services it uses. See [Setup and access](01-setup-and-access.md).

## Features

| Feature | What it does |
| --- | --- |
| [Setup and access](01-setup-and-access.md) | The shipped config fragment, the `users:*`, `user:read` and `user.metadata:*` permissions, how a route decides a conditional grant, and every config key the package reads |
| [Current user argument](02-current-user.md) | `@CurrentUser()` / `CurrentUserArg`: the signed-in user's row in any controller action; replace or extend it |
| [Own account routes](03-own-account.md) | `UserController`: `GET /user`, and the roles and profiles a new API token may carry |
| [User metadata routes](04-user-metadata-routes.md) | `UserMetadataController`: CRUD of key-value metadata, own (`/user/metadata`) and of another user (`/user/:uuid/metadata`), reserved keys hidden |
| [Metadata service](05-metadata-service.md) | `UserMetadataService` and `MetadataScope`: reuse them in your own routes, subclass or replace them |
| [User administration](06-user-administration.md) | `Users`: list, filter and sort accounts, read one, create (invite), update login, email and roles, delete and restore |
| [Account lifecycle and sessions](07-lifecycle-and-sessions.md) | `Security`: activate, deactivate, ban, unban, list and end a user's sessions, with fresh authentication and the credential admin guard |
| [Account guard](08-account-guard.md) | `AccountGuard` / `DefaultAccountGuard`: self lockout and last privileged account rules; extend or replace them |
| [Admin profile route](09-admin-profile.md) | `Profile`: `GET /users/profile/:login` through the config-selected `UserProfileProvider` |
| [Controller overrides](10-controller-overrides.md) | Replace or extend any shipped controller by subclassing it and registering the subclass in DI |
| [Host services](11-host-services.md) | The services of other packages this one resolves (credential admin guard, account status source, session issuer, token services, ...), and what happens when one is missing |

## Quick start

A route of your own that answers with the signed-in user's display name, behind the `user:read` permission users' `user` role holds on its own record:

```ts sample
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Access } from '@spinajs/authz-http';
import type { User } from '@spinajs/users';
import { CurrentUser } from '@spinajs/users-http';

@BasePath('me')
export class MeController extends BaseController {
  /** GET /me/greeting: 401 without a signed-in user, 403 for a service principal. */
  @Get('greeting')
  @Access('user:read')
  public greeting(@CurrentUser() user: User) {
    const niceName = user.Metadata['user:niceName'] ?? user.Login;
    return new Ok({ text: `Hello, ${niceName}` });
  }
}
```

Grant the admin routes with ordinary role grants:

```js
authz: {
  rbac: {
    roles: {
      'user-admin': { grants: ['users:read', 'users:create', 'users:update', 'users:delete', 'users:credentials'] },
    },
  },
}
```

## Migration to 3.0

| 2.x | 3.0 |
| --- | --- |
| `AuthorizedPolicy` + `@Permission`, `readOwn` / `updateOwn` grants | `@Access('users:<action>')`; own-record access is a conditional grant (`relation: 'self'`) decided on the row |
| `GET /user/refresh` | `GET /user` |
| `GET /user/grants` | `GET /user/access` of `@spinajs/authz-http` |
| `PATCH /user/password`, `changePassword`, `password-reset-request`, `expire-password`, `reset2fa`, `2fa/enable`, `2fa/disable`, `unlock` under `/users/security` | removed; credential routes are in [`@spinajs/authn-http`](../authn-http/12-password-routes.md) |
| `DELETE /users/security/sessions/:uuid` (end every session) | `DELETE /authn/admin/users/:uuid/sessions` of `@spinajs/authn-http`, answering `{ revoked }` |
| `GET /users/security/activate/:uuid`, `GET .../deactivate/:uuid` | `POST` |
| Session list entry with `Expires` | `IAdminSessionEntry`: `{ Handle, Created, LastSeen, Ip?, UserAgent? }` |
| `PATCH /users/:uuid` with `Metadata` | refused; use the [metadata routes](04-user-metadata-routes.md) |
| Metadata list sorted by any column | `Id`, `Key` or `Type`; anything else `400` |
| Exports `ChangePasswordDto`, `PasswordDto` | removed |

Delete, deactivate, ban, the session revoke and an `Email` / `Login` change now need fresh authentication (`reauthPassword` in the body), and all but the own-account identity change need the credential admin guard (`users:credentials`). `users:*` covers `users:credentials`: a role manager holding single `users:<action>` grants without it can no longer hand out `admin.users`.

```js
// 2.x
rbac: { grants: { support: { users: { 'read:any': ['*'], 'update:own': ['*'] } } } }

// 3.0
authz: { rbac: { roles: { support: { grants: ['users:read', { permission: 'users:update', relation: 'self' }] } } } }
```

The full mapping of 2.x grants and decorators is in the [authz migration guide](../authz/migration-guide.md).

## Related packages

- [`@spinajs/users`](../users/README.md): the `User` model, its metadata, account actions, the shipped `user` and `admin.users` roles, `UserProfileProvider`, `AuthzCredentialAdminGuard` and `UserAccountStatusSource`.
- [`@spinajs/authz`](../authz/README.md): `AuthzService`, `AuthzAdmin` and the decisions every route here asks for.
- [`@spinajs/authn`](../authn/README.md): the `CredentialAdminGuard`, `SessionIssuer`, `TokenService` and `RoleSource` contracts these routes resolve.
- `@spinajs/authn-http`: the `FreshAuth` policy, the session-only caller policies, and the credential routes this package does not serve.
- `@spinajs/authz-http`: `@Access`, `@CurrentPrincipal` and the principal middleware.
- `@spinajs/authz-rbac`: `AccountStatusSource`, `AssignmentStore`, `RoleStore`, `guardSwitches` and the token role rules.
- [`@spinajs/http`](../http/README.md): controllers, route arguments and the controller scan that mounts this package.
- [`@spinajs/orm-http`](../orm-http/README.md): `@Filter`, `PaginationDTO` and `OrderDTO` on the list routes.
- [`@spinajs/di`](../di/README.md): every service here is replaced with `DI.register(Mine).as(Base)`.
