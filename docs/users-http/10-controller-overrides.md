# Controller overrides

Every controller of this package is an ordinary DI class. Subclass it, register the subclass under the package class, and the controller scan mounts yours in its place: change what an action answers, adjust a protected hook, or add rules, without forking the package.

## How it works

1. The controller scan lists the package classes (`UserController`, `UserMetadataController`, `Users`, `Security`, `Profile`) from `system.dirs.controllers`.
2. `Controllers.resolve()` resolves each listed class through DI. `DI.register(Mine).as(UserController)` makes that resolve return `Mine`: the last registration under a key wins.
3. Only the subclass is mounted. Its routes are the inherited ones plus any it declares.
4. Route rules are inherited: an action you override keeps the base class's `@Access(...)` and route decorators, whether you redeclare `@Get(...)` without `@Access`, or override the method body with no decorator at all.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `UserController` | Class key; singleton; mounted by the scan | `UserController` | yours | `DI.register(Mine).as(UserController)`. Fields: `AccessDomain` (`@Config('authz.http.access.domain')`). |
| `UserMetadataController` | Class key; singleton | `UserMetadataController` | yours | `DI.register(Mine).as(UserMetadataController)`. Field: `Metadata` (`UserMetadataService`). |
| `Users` | Class key; singleton | `Users` | yours | `DI.register(Mine).as(Users)`. Hooks: `sortColumn(order)`, `asDuplicateResponse(work)`. Field: `AccountGuard` (the role replacement). |
| `Security` | Class key; singleton | `Security` | yours | `DI.register(Mine).as(Security)`. The account guard of its routes is `AccountDisableHook`, a `users.*` before hook, not a field. |
| `Profile` | Class key; singleton | `Profile` | yours | `DI.register(Mine).as(Profile)`. Field: `ProfileService` (`UserProfileProvider`). |

Register the subclass before the HTTP server resolves its controllers, in a module your application imports at startup. Importing the base class from `@spinajs/users-http` guarantees the package's registrations run first.

<!-- TODO(docs-hook): verify whether a subclass placed inside the application's own scanned controllers directory is mounted once or twice (the scan lists the subclass and the base, which resolves to the subclass). -->

### `UserController`: answer `GET /user` in your application's shape

The override keeps `@Access('user:read', { resource: ownUser, subject: 'load', fields: 'filter' })` of the base action: a caller without `user:read` on its own row still gets `403`, and the answer is still cut to the fields the grant reads.

```ts sample
import { DI } from '@spinajs/di';
import { Get, Ok } from '@spinajs/http';
import type { User } from '@spinajs/users';
import { CurrentUser, UserController } from '@spinajs/users-http';

export class AppUserController extends UserController {
  @Get('/')
  public async refresh(@CurrentUser() user: User): Promise<Ok<any>> {
    return new Ok({
      Login: user.Login,
      Email: user.Email,
      DisplayName: user.Metadata['user:niceName'] ?? user.Login,
    });
  }
}

DI.register(AppUserController).as(UserController);
```

### `Users`: sort the admin list by login by default

`Users.sortColumn(order)` picks the sort column and refuses unknown ones with `400`. Override it to change the default and keep the whitelist through `super`.

```ts sample
import { DI } from '@spinajs/di';
import type { OrderDTO } from '@spinajs/orm-http';
import { Users } from '@spinajs/users-http';

export class LoginOrderedUsers extends Users {
  protected sortColumn(order?: OrderDTO): string {
    return order?.column ? super.sortColumn(order) : 'Login';
  }
}

DI.register(LoginOrderedUsers).as(Users);
```

The direction still defaults to `DESC`; clients send `order={"order":"ASC"}` for A to Z.

## Important behaviour

- The base class stays registered and importable; only the resolve under its key changes. Unregistering the subclass (`DI.unregister(Mine)`, then `DI.uncache(Base)`) brings the package controller back.
- A redeclared route keeps the inherited `@Access`; you cannot drop the permission check by overriding the action.
- The route path comes from the base controller's `@BasePath` and the action's route decorator; overriding the method does not move it.
- `Users.asDuplicateResponse()` must rethrow a plain `ResourceDuplicated`: the error map of `@spinajs/http` looks the response up by `err.constructor.name`, and a subclass answers `500`.

## Best practices

- Add new routes in a controller of your own under another base path. A new `GET /users/<word>` route in a `Users` subclass competes with `GET /users/:uuid`.
- Override protected hooks before whole actions: the action keeps its checks, ordering and error mapping.
- When the change is about a service (the guard, the metadata service, the profile provider), replace the service, not the controller: [Account guard](08-account-guard.md), [Metadata service](05-metadata-service.md), [Admin profile route](09-admin-profile.md).

## Patterns and antipatterns

```ts
// Don't: copy the package controller into your app. You lose every fix and check the package adds later,
// and both copies are mounted on the same paths.
@BasePath('users')
export class MyUsers extends BaseController { /* pasted actions */ }

// Do: subclass and register under the package class.
export class MyUsers extends Users { /* overrides */ }
DI.register(MyUsers).as(Users);
```

## Related

- [Controller discovery](../http/03-controller-discovery.md): how the scan lists and resolves controllers.
- [Controllers and routing](../http/02-controllers-and-routing.md): `@BasePath`, route decorators and descriptor inheritance.
- [Descriptor inheritance](../di/14-descriptor-inheritance.md): how a subclass inherits injected fields.
