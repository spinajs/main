# Current user argument

`@CurrentUser()` injects the signed-in user's `User` row, with its metadata, into a controller action. Use it in any controller that acts for a person; use `@CurrentPrincipal()` from `@spinajs/authz-http` when you need the principal (roles, type, sign-in facts) instead of the row.

## How it works

1. `@CurrentUser()` is `Route(Parameter('CurrentUserArg'))`: it records a parameter whose handler is the DI name `CurrentUserArg`.
2. Per request, `@spinajs/http` resolves `'CurrentUserArg'` and calls `CurrentUserArg.extract()`.
3. `extract()` reads the principal from `req.storage.Principal`, which the authz principal middleware set.
4. No principal, or `authenticated !== true`: it throws `Unauthenticated` (`401`).
5. `principal.type !== 'user'` (a service, or an agent acting for a user): it throws `Forbidden` (`403`).
6. It reads the row as `SYSTEM`: `userModel().query().whereUuid(principal.id).populate('Metadata').first()`.
7. No row, or `DeletedAt` set (deleted since the request authenticated): `Unauthenticated` (`401`).
8. The row becomes the action argument.

The argument never resolves to `null`: an action with `@CurrentUser()` never runs without its user.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@CurrentUser()` | action parameter | none | The signed-in user's `User` row with `Metadata` populated. `401` or `403` as above. |

It does **not** check permissions. Put `@Access(...)` on the action as well.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `CurrentUserArg` (a `RouteArgs`) | String key `'CurrentUserArg'` (its class name), registered by `@Injectable()`; singleton; resolved per request by `@spinajs/http` | `CurrentUserArg` | none shipped | Subclass it and `DI.register(Mine).as(CurrentUserArg)`; every `@CurrentUser()` then gets yours. Override `extract()` and call `super.extract()` to keep the checks. |
| User model | `userModel()` of `@spinajs/users` | `User` | an application model registered with users' model token | See [`@spinajs/users`](../users/README.md); `CurrentUserArg` reads through it. |

The handler is a singleton shared by every request: keep request data in local variables, never in fields. See [Custom route arguments](../http/05-custom-route-arguments.md) for the `RouteArgs` contract.

### `CurrentUserArg`: refuse banned accounts everywhere

The default argument checks that the account exists, not that it is in service. Extend it so every `@CurrentUser()` route also refuses a banned or deactivated account with `403`. Register the subclass after `@spinajs/users-http` is imported (importing it from the package guarantees that) and before the first request.

```ts sample
import { DI } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import type { IRouteArgsResult, IRouteCall, IRouteParameter, Request } from '@spinajs/http';
import type { User } from '@spinajs/users';
import { CurrentUserArg } from '@spinajs/users-http';

export class ActiveCurrentUserArg extends CurrentUserArg {
  public async extract(callData: IRouteCall, args: unknown[], param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    const result = await super.extract(callData, args, param, req);
    const user = result.Args as User;

    if (user.IsBanned) {
      throw new Forbidden('this account is banned');
    }
    if (!user.IsActive) {
      throw new Forbidden('this account is not active');
    }

    return result;
  }
}

// Last registration under 'CurrentUserArg' wins.
DI.register(ActiveCurrentUserArg).as(CurrentUserArg);
```

## Important behaviour

- The row is read again on every request, as `SYSTEM`. A scoped user model (an `@AccessResource`) does not hide the caller's own row.
- An agent acting for a user is refused (`403`), as for the `self` relation: it is not that user.
- `Metadata` is populated, so `user.Metadata['user:niceName']` and `user.IsBanned` work without another query. Reserved security keys stay hidden in `dehydrateWithRelations()`.
- The DI name must stay `CurrentUserArg`: `@spinajs/http` resolves route arguments by that string, so another package's class with the same name would clash.

## Best practices

- Put `@Access(...)` with the permission the action needs next to `@CurrentUser()`; the argument only proves who the caller is.
- Take `@CurrentPrincipal()` instead when the action must also serve service principals: `@CurrentUser()` refuses them.
- Answer with `user.dehydrateWithRelations({ dateTimeFormat: 'iso' })`, not the model, so hidden keys stay hidden.

## Patterns and antipatterns

```ts
// Don't: look the user up from the principal yourself. A scoped model can hide the row, and a deleted account passes.
public async me(@CurrentPrincipal() caller: Principal) {
  const user = await User.where('Uuid', caller.id).first();
  return new Ok(user);
}

// Do
public async me(@CurrentUser() user: User) {
  return new Ok(user.dehydrateWithRelations({ dateTimeFormat: 'iso' }));
}
```

## Examples

### Answer the signed-in user's account summary

```ts sample
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Access } from '@spinajs/authz-http';
import type { User } from '@spinajs/users';
import { CurrentUser } from '@spinajs/users-http';

@BasePath('me')
export class AccountSummaryController extends BaseController {
  /** GET /me/summary */
  @Get('summary')
  @Access('user:read')
  public summary(@CurrentUser() user: User) {
    return new Ok({
      Login: user.Login,
      DisplayName: user.Metadata['user:niceName'] ?? user.Login,
      Active: user.IsActive,
      MemberSince: user.CreatedAt?.toISO(),
    });
  }
}
```

## Related

- [Custom route arguments](../http/05-custom-route-arguments.md): the `RouteArgs` contract this argument implements.
- [Own account routes](03-own-account.md): `GET /user` is built on it.
- [Metadata service](05-metadata-service.md): `ownMetadata(req, user)` takes the row this argument gives.
