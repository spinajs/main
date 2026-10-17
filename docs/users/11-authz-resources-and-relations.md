# Authz resources and relations

What users teaches the authz engine: the `user` resource (one account, by `Uuid`), the `self` relation (a user's own record), the `owner` relation on `user.metadata` rows, the permissions those name, and the roles `guest`, `user`, `admin.users` and `admin`. Extend it with your own relations (a manager over their reports) or more grants on the shipped roles.

## How it works

1. Importing users registers `UserResourceAdapter` (`ResourceAdapter`) and three `RelationResolver`s: `UserSelfRelation`, `UsersSelfRelation`, `UserMetadataOwnerRelation`.
2. When a domain boots, authz collects the adapters' `permissions()`. `UserResourceAdapter` registers:

| Permission | Resource | Action | Types | Fields |
| --- | --- | --- | --- | --- |
| `user:read` | `user` | `read` | `user` | yes |
| `user:update` | `user` | `update` | `user` | yes |
| `user:impersonate` | `user` | `impersonate` | `user` | |
| `user.metadata:read`, `:create`, `:update`, `:delete` | `user.metadata` | each | `user.metadata` | |
| `users:credentials` | `users` | `credentials` | `users` | |

3. A check on `{ type: 'user', id: <Uuid> }` asks `UserResourceAdapter.ancestors(ref)`. It reads the row through `userModel()` as `SYSTEM`: an existing, not soft-deleted user gives `[ref, GLOBAL]`; an unknown or deleted one gives `null`, so every check on it fails closed. A type-level ref (no `id`) gives `[ref, GLOBAL]`.
4. When a check needs the row (authz-http's `subject: 'load'`), `load(ref)` returns the user with `Metadata`, or `null`.
5. A grant with `relation: 'self'` asks `UserSelfRelation` (type `user`) or `UsersSelfRelation` (type `users`): the principal must be a `user`, and
   - without a subject: `ref.id === principal.id`;
   - with a subject: it must be a user row (a `UserBase`, or any object with a string `Uuid`), `ref.id` must name that row (its `Uuid` or its `Id`), and the row's `Uuid` must be `principal.id`.
6. A grant with `relation: 'owner'` on `user.metadata` asks `UserMetadataOwnerRelation`: the subject must be a metadata row with an integer `user_id`; a ref with an `id` must name that row's `Id`; and the principal's `users.Id` (read once per request as `SYSTEM`, `undefined` for a deleted user) must equal `user_id`.

`UserResourceAdapter.accepts()` always answers `false`: user records passed as objects belong to the `users` resource of the ORM adapter (`@spinajs/authz-orm`). Build a `user` check with `adapter.refOf(user)` and pass the row as subject.

### Shipped roles (`authz.rbac.roles`)

| Role | Grants |
| --- | --- |
| `guest` | `user:read` on `self`, fields read `Login` |
| `user` | `user:read` on `self` (fields read `Email`, `Login`); `user:update` on `self` (fields write `Email`, `Login`, `Password`); `user.metadata:*` on `owner` |
| `admin.users` | `users:*`, `user.metadata:*`; `assignable: false` |
| `admin` | extends `admin.users`; `user:impersonate` |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.rbac.roles.<role>.grants` | grant list | the table above | authz-rbac grants | Grants of a role. Your list is **concatenated** with the shipped one: you can add grants, not remove them. |
| `authz.rbac.roles.<role>.extends` | `string[]` | `admin` extends `admin.users` | role names | Role inheritance. |
| `authz.rbac.roles.<role>.assignable` | `boolean` | `false` for `admin.users` | | Whether the role can be granted directly. |

```ts
// config/authz.ts in your app
export default {
  authz: {
    rbac: {
      roles: {
        user: {
          grants: [{ permission: 'user:read', relation: 'self', fields: { read: ['Email', 'Login', 'CreatedAt'] } }],
        },
        support: {
          grants: ['user:read', 'user.metadata:read'],
        },
      },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `user` resource | `ResourceAdapter` list (`Array.chainOf`), singleton, `@Injectable(ResourceAdapter)` on import | `UserResourceAdapter` | your adapter | Subclass and override the protected `find(uuid, withMetadata)`, `ancestors()` or `permissions()`; `DI.unregister(UserResourceAdapter)` and register yours. |
| `self` on `user` / `users` | `RelationResolver` list, singleton | `UserSelfRelation`, `UsersSelfRelation` | | The host refuses two resolvers for one type and relation: `DI.unregister()` the shipped one before registering a replacement. |
| `owner` on `user.metadata` | `RelationResolver` list, singleton | `UserMetadataOwnerRelation` | | Subclass and override the protected `userIdOf(uuid)` or `userOf(uuid)`; unregister the shipped one. |
| Your relations | `RelationResolver` list | | any `type` + `relation` pair not taken | `@Injectable(RelationResolver)` on your class, then grant with `relation: '<name>'`. |
| Shipped roles | `authz.rbac.roles` config fragment | the table above | | Add grants or roles in your config. |

### Custom relation: a manager reads their reports

The relation holds when the user row's `hr:manager` metadata names the principal.

```ts sample
import { Injectable } from '@spinajs/di';
import { RelationResolver } from '@spinajs/authz';
import type { Principal, ResourceRef } from '@spinajs/authz';
import { UserBase } from '@spinajs/users';

@Injectable(RelationResolver)
export class UserManagerRelation extends RelationResolver {
  public readonly type = 'user';
  public readonly relation = 'manager';

  public holds(principal: Principal, ref: ResourceRef, subject?: unknown): boolean {
    if (principal.type !== 'user' || !(subject instanceof UserBase) || ref.id !== subject.Uuid) {
      return false;
    }
    // Needs the row with metadata: check with subject 'load', which populates Metadata.
    return subject.Metadata?.['hr:manager'] === principal.id;
  }
}

// config/authz.ts in your app:
// authz.rbac.roles.user.grants: [{ permission: 'user:read', relation: 'manager', fields: { read: ['Email', 'Login'] } }]
```

### Replace `self`: let agents act on their owner's record

`self` ignores `onBehalfOf` on purpose. If your agents should read their owner's record, replace the resolver.

```ts sample
import { DI } from '@spinajs/di';
import { RelationResolver } from '@spinajs/authz';
import type { Principal, ResourceRef } from '@spinajs/authz';
import { UserSelfRelation } from '@spinajs/users';

export class DelegatedUserSelfRelation extends UserSelfRelation {
  public holds(principal: Principal, ref: ResourceRef, subject?: unknown): boolean {
    const acting = principal.type === 'agent' && principal.onBehalfOf ? principal.onBehalfOf : principal;
    return super.holds(acting, ref, subject);
  }
}

DI.unregister(UserSelfRelation);
DI.register(DelegatedUserSelfRelation).as(RelationResolver);
```

## Important behaviour

- Every check on an unknown or soft-deleted user fails closed: `ancestors()` answers `null`.
- `self` and `owner` never read `onBehalfOf`: an agent acting for a user holds neither on that user's records.
- `owner` needs the metadata row as subject; a type-level check on `user.metadata` without a row never holds.
- `UserMetadataOwnerRelation` caches the principal's `users.Id` per request (`requestScope().cache`), so a list check reads the user once. A failed lookup is not cached.
- The permissions come with the adapter, not with the config fragment: they register only where `UserResourceAdapter` is registered. A role that names `user:read` in a domain without it cannot be granted.
- An account holding both `guest` and `user` reads only `Login` of its own row until authz unions same-condition grants (RFC C3-1).
- `admin.users` holds `users:credentials` through `users:*`; the [credential admin guard](13-impersonation-and-credential-admin-guards.md), not a missing permission, keeps it off accounts it does not cover.

## Best practices

- Pass the row as subject (or use `subject: 'load'`) for `self`; a ref alone decides only by `Uuid`.
- Name new relations after the business rule (`manager`, `teammate`), and register them next to the grants that use them.
- Narrow `admin.users` by revoking permissions from the role in your config, not by editing the shipped fragment.

## Patterns and antipatterns

```ts
// Don't: register a second 'self' resolver for 'user'; the authz host refuses it at boot
DI.register(DelegatedUserSelfRelation).as(RelationResolver);

// Do: remove the shipped one first
DI.unregister(UserSelfRelation);
DI.register(DelegatedUserSelfRelation).as(RelationResolver);
```

## Related

- [`@spinajs/authz`](../authz/README.md): resource adapters, relations, field grants and the check flow.
- [Default roles](12-default-roles.md): which of these roles new users get.
- [Custom user model](02-custom-user-model.md): the model `UserResourceAdapter` and `owner` read.
- [Principal factory](09-principal-factory.md): the principals these relations compare.
