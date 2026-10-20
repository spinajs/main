# Admin profile route

`GET /users/profile/:login` answers a user's profile as the configured `UserProfileProvider` builds it. The provider is picked by name in `users.user.profile`; swap it to add data from other parts of your application (orders, posts, plan) without changing the route.

## How it works

1. `@Access('users:read', { fields: 'filter' })` decides `users:read` on the type.
2. `userRowFor(caller, 'users:read', lookup)` runs the lookup as `SYSTEM`: it queries `Uuid`, then `Login`, then `Email` for the value, with `Metadata` populated, and takes the first live row. `:login` may be a login, a uuid or an email address; it is never read as the numeric `Id`. A soft-deleted row counts as missing.
3. A conditional grant is decided again on the row; a missing row answers `404` to an unconditional grant, `403` to a conditional one.
4. The handler calls `ProfileService.retrieve(user)` with the **row** the decision was made on, never the identifier.
5. It answers the provider's result.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `users.user.profile` | `string` | `'BasicProfileProvider'` (users fragment) | the class name of a registered `UserProfileProvider` | The provider `Profile` gets |

```js
users: {
  user: {
    profile: 'OrdersProfileProvider',
  },
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `UserProfileProvider` | Abstract class of `@spinajs/users`; `@AutoinjectService('users.user.profile')` into `Profile`, by registration name; singleton | `BasicProfileProvider`: `new UserProfile(user)` | yours | `@Injectable(UserProfileProvider)` on a subclass, then set `users.user.profile` to its class name. |
| `Profile` controller | Class key `Profile`; singleton; mounted by the controller scan | `Profile` | none | Subclass and `DI.register(Mine).as(Profile)`; see [Controller overrides](10-controller-overrides.md). |

The answer is `UserProfile<T>`: `{ User, AdditionalData? }`. See [Config-selected services](../configuration/08-config-selected-services.md) for how `@AutoinjectService` resolves a name.

### `UserProfileProvider`: add order statistics

The provider gets a `User` row (the route always passes one), and may also be called with a uuid, id or login by other code; `getUser()` of `@spinajs/users` covers those.

```ts sample
import { Injectable } from '@spinajs/di';
import { User, UserProfile, UserProfileProvider, getUser } from '@spinajs/users';

export interface OrderStats {
  orders: number;
  lastOrderAt: string | null;
}

/** Stand-in for your order store. */
async function orderStatsOf(userId: number): Promise<OrderStats> {
  return { orders: userId > 0 ? 3 : 0, lastOrderAt: null };
}

@Injectable(UserProfileProvider)
export class OrdersProfileProvider extends UserProfileProvider {
  public async retrieve<T>(user: string | number | User): Promise<UserProfile<T>> {
    const row = user instanceof User ? user : await getUser(user);
    const stats = await orderStatsOf(row.Id);
    return new UserProfile<T>(row, stats as unknown as T);
  }
}
```

Then set `users.user.profile` to `'OrdersProfileProvider'`.

## Important behaviour

- The configured name must match a registered class name. An empty value only logs a warning and leaves the provider `undefined`, so every request fails with `500`.
- The provider's result is answered as is; `fields: 'filter'` applies to the response. Do not put fields in `AdditionalData` that `users:read` holders must not see.
- The lookup tries `Uuid`, `Login`, `Email` in that order: when one account's login equals another's email address, the login match wins.

## Best practices

- Keep `retrieve()` read-only and fast; it runs on every request of the route.
- Accept every identifier form in `retrieve()`, as `BasicProfileProvider` does, so other code can reuse the provider.

## Examples

### Read a profile from an admin client

```ts sample
interface Profile<T> {
  User: { Uuid: string; Login: string; Email?: string };
  AdditionalData?: T;
}

type Api = (path: string) => Promise<Response>;

export async function profileOf<T>(api: Api, login: string): Promise<Profile<T> | null> {
  const res = await api(`/users/profile/${encodeURIComponent(login)}`);
  return res.status === 404 ? null : ((await res.json()) as Profile<T>);
}
```

## Related

- [`@spinajs/users`](../users/README.md): `UserProfileProvider`, `UserProfile`, `BasicProfileProvider`.
- [Config-selected services](../configuration/08-config-selected-services.md): how a config value picks an implementation.
- [User administration](06-user-administration.md): the other `users:read` routes.
