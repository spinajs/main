# User profile

A `UserProfileProvider` answers "everything we show about this user": the `User` record plus whatever your application adds (order counts, plan, avatar URL). users ships `BasicProfileProvider`, which returns the record alone; configure your own provider by class name.

## How it works

1. A provider class extends `UserProfileProvider` and registers with `@Injectable(UserProfileProvider)`.
2. `users.user.profile` names the provider class to use (default `'BasicProfileProvider'`).
3. A consumer injects it by that name: users-http's admin `Profile` controller uses `@AutoinjectService('users.user.profile')`, which finds the registered `UserProfileProvider` type of that class name and builds it with the config entry as its first constructor argument.
4. The consumer calls `retrieve<T>(user)` with a `User`, an id, a UUID, an email or a login.
5. `BasicProfileProvider.retrieve()` loads the user with `getUser()` and returns `new UserProfile(user)`.

`UserProfile<T>` has `User: User` and `AdditionalData?: T`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `users.user.profile` | `string \| { service: string, ...options }` | `'BasicProfileProvider'` | class name of a registered `UserProfileProvider` | Provider consumers get. An object passes its fields to the provider's constructor. |

The 2.x key `rbac.user` maps to `users.user` (authz legacy key table).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Profile provider | `UserProfileProvider` (abstract), each implementation `@Injectable(UserProfileProvider)`; picked by class name from `users.user.profile` | `BasicProfileProvider` | your provider | Register your class and set `users.user.profile` to its name. `DI.resolve(UserProfileProvider)` by type returns the last registered one. |

### Custom provider: profile with order statistics

```ts sample
import { Injectable } from '@spinajs/di';
import { UserProfile, UserProfileProvider, getUser } from '@spinajs/users';
import type { User } from '@spinajs/users';

export interface SalesProfile {
  orders: number;
  lifetimeValueCents: number;
}

interface OrderStats {
  countFor(userUuid: string): Promise<{ orders: number; totalCents: number }>;
}

@Injectable(UserProfileProvider)
export class SalesProfileProvider extends UserProfileProvider {
  // Replace with your own data access; a real provider would @Autoinject it.
  protected Stats: OrderStats = { countFor: async () => ({ orders: 0, totalCents: 0 }) };

  public async retrieve<T>(user: string | number | User): Promise<UserProfile<T>> {
    const u = await getUser(user);
    const stats = await this.Stats.countFor(u.Uuid);
    const data: SalesProfile = { orders: stats.orders, lifetimeValueCents: stats.totalCents };
    return new UserProfile<T>(u, data as unknown as T);
  }
}

// config/users.ts in your app
export default {
  users: {
    user: { profile: 'SalesProfileProvider' },
  },
};
```

## Important behaviour

- `BasicProfileProvider` loads by `getUser()`, so an identifier that is not a `User` goes through the application's user model with `Metadata` populated.
- The provider does no access check; users-http decides `users:read` on the row before it calls `retrieve()`, and passes the row, not the raw identifier.
- `@AutoinjectService` only warns on a missing or empty `users.user.profile` and leaves the property `undefined`.
- `retrieve<T>()` is generic only in its declaration: the provider decides the shape of `AdditionalData`.

## Best practices

- Accept a `User` in `retrieve()` and avoid reloading it; callers usually hold the row already.
- Keep secrets and reserved metadata out of `AdditionalData`; it is sent to clients as is.

## Related

- [User model and metadata](01-user-model.md): the `User` inside the profile.
- [Config-selected services](../configuration/08-config-selected-services.md): how `@AutoinjectService` picks the provider.
