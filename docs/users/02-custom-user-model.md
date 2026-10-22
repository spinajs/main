# Custom user model

Replace the user model class that users, authz and users-http query with your own subclass of `User`. Do it to add columns, query scopes or ORM hooks (for example `@AccessResource('users')` of `@spinajs/authz-orm`) without forking the package.

## How it works

1. `RbacBootstrapper.bootstrap()` stores `User` in the root DI cache under `RBAC_USER_MODEL` (`'RbacUserModel'`), but only when nothing is cached under that key yet.
2. Your code stores its subclass with `DI.register(AppUser).asValue(RBAC_USER_MODEL, true)`. The `true` replaces any earlier value, so the order against the bootstrapper does not matter.
3. `userModel()` returns `DI.get(RBAC_USER_MODEL)`, or `User` when the key is empty.
4. Every lookup that must honour the application model calls `userModel()`. Lookups that must see every row, whatever the application's scoping, use the base `User` (see the table below).
5. The static getters (`getByLogin`, `getByEmail`, `getByUuid`, `getByAnything`) build their query from the receiving class, so `AppUser.getByEmail()` uses `AppUser`'s scopes and hooks.

It is a **class** token, not an instance factory: authz query enforcement keys off the class a static query was built from.

### Who uses which class

| Code | Class | Why |
| --- | --- | --- |
| `getUser()`, `getUsersByRole()`, `_get_user()` | `userModel()` | Application reads. |
| `UserPrincipalFactory`, `UserInitiatorPrincipalFactory`, `UserResourceAdapter`, `UserMetadataOwnerRelation` | `userModel()`, run as `SYSTEM` | The principal's `identity` is your subclass; a scoped model cannot hide the row from the lookup. |
| `getUserUnsafe()` | `UserBase` | Reads any row. |
| `assertUserUnique()`, `create()` | base `User` | Uniqueness is global; `create()` inserts a `new User(...)`. |
| `UserIdentityStore`, `UserPasswordStore`, `UserPasswordAgeSource`, `UserPasswordStateHook`, `QueueAuthnEventSink`, `UserAccountStatusSource` | base `User` or its driver, run as `SYSTEM` where it matters | Login, reset and admin checks see every row, soft-deleted ones included. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| User model class | `RBAC_USER_MODEL` (`'RbacUserModel'`), a value in the root cache, set by `RbacBootstrapper` | `User` | any subclass of `User` | `DI.register(AppUser).asValue(RBAC_USER_MODEL, true)` before the first user lookup. |
| Query scopes | static `_queryScopes` on the model | `UserQueryScopes` | your subclass of `UserQueryScopes` | Assign it on your model; redeclare the inherited methods you call (see below). |

### Register an application user model

The subclass needs its own `@Connection` and `@Model` decorators, or the ORM never registers it and its descriptor lacks the table columns. Its extra columns must exist in the `users` table (add them with your own migration).

```ts sample
import { DI } from '@spinajs/di';
import { Connection, Migration, Model, OrmDriver, OrmMigration } from '@spinajs/orm';
import { RBAC_USER_MODEL, User, getUser } from '@spinajs/users';

@Connection('default')
@Model('users')
export class AppUser extends User {
  public Department: string;
}

@Migration('default')
export class AppUserDepartment_2026_10_17_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('users', (table) => {
      table.string('Department', 64);
    });
  }

  public async down(): Promise<void> {}
}

DI.register(AppUser).asValue(RBAC_USER_MODEL, true);

export async function departmentOf(uuid: string): Promise<string> {
  // getUser() queries userModel(), so the row comes back as AppUser
  const user = (await getUser(uuid)) as AppUser;
  return user.Department;
}
```

### Add query scopes

The ORM binds only the methods declared on the scope object's **own** class; methods inherited from `UserQueryScopes` are not bound. Extend `UserQueryScopes`, redeclare every inherited scope you or users call (users calls `whereAnything` and `whereUuid` on `userModel()`), and add your own.

```ts sample
import { DI } from '@spinajs/di';
import { Connection, ISelectQueryBuilder, Model } from '@spinajs/orm';
import { RBAC_USER_MODEL, User, UserQueryScopes } from '@spinajs/users';

export class AppUserQueryScopes extends UserQueryScopes {
  // Redeclared: inherited scope methods are not bound to the builder.
  public whereAnything(this: ISelectQueryBuilder<User[] | User> & UserQueryScopes, identifier: string | number) {
    return super.whereAnything(identifier);
  }

  public whereUuid(this: ISelectQueryBuilder<User[]> & UserQueryScopes, uuid: string) {
    return super.whereUuid(uuid);
  }

  public whereEmail(this: ISelectQueryBuilder<User[]> & UserQueryScopes, email: string) {
    return super.whereEmail(email);
  }

  public whereLogin(this: ISelectQueryBuilder<User[]> & UserQueryScopes, login: string) {
    return super.whereLogin(login);
  }

  public isActiveUser(this: ISelectQueryBuilder<User[]> & UserQueryScopes) {
    return super.isActiveUser();
  }

  public inDepartment(this: ISelectQueryBuilder<User[]> & AppUserQueryScopes, department: string) {
    return this.where('Department', department);
  }
}

@Connection('default')
@Model('users')
export class AppUser extends User {
  public static readonly _queryScopes: AppUserQueryScopes = new AppUserQueryScopes();

  public Department: string;
}

DI.register(AppUser).asValue(RBAC_USER_MODEL, true);

export async function salesTeam(): Promise<AppUser[]> {
  // Scopes typed on UserQueryScopes return that type, so call your own scopes first.
  return (await AppUser.query().inDepartment('sales').isActiveUser()) as AppUser[];
}
```

## Important behaviour

- `create()` inserts a base `User`, not your subclass. A `users.create` hook gets its columns as plain data, your own columns included (see [Action hooks](04-action-hooks.md)); `getUser()` reads it back as your subclass.
- `userModel()` falls back to `User` when the cache is empty, for example in a CLI process before the bootstrappers ran.
- An `@AccessResource` model is safe here: every users lookup that must not be scoped runs inside `AuthzService.runAs(SYSTEM, ...)`.
- `DI.register(AppUser).asValue(RBAC_USER_MODEL)` without `true` adds a value instead of replacing it. Always pass `true`.

## Best practices

- Keep the subclass on the `users` table and the `default` connection. Every users store writes through `User.query().Driver`, the base model's connection.
- Register the model in the module that defines it, imported from the application entry, so it is in place before the first request, job or CLI command.
- Call `userModel()` in your own code instead of importing `AppUser` where the base API is enough; tests can then swap the model.

## Patterns and antipatterns

```ts
// Don't: an inherited scope is not bound, so whereAnything is undefined on AppUser queries
export class AppUserQueryScopes extends UserQueryScopes {
  public inDepartment(this: ISelectQueryBuilder<User[]>, department: string) { return this.where('Department', department); }
}

// Do: redeclare the inherited scopes you need, delegating to super
export class AppUserQueryScopes extends UserQueryScopes {
  public whereAnything(this: ISelectQueryBuilder<User[] | User> & UserQueryScopes, identifier: string | number) {
    return super.whereAnything(identifier);
  }
  public inDepartment(this: ISelectQueryBuilder<User[]>, department: string) { return this.where('Department', department); }
}
```

## Related

- [User model and metadata](01-user-model.md): the base model, its scopes and schema.
- [Scopes and builder extensions](../orm/16-scopes-and-builder-extensions.md): how scopes are bound.
- [Values and value maps](../di/09-values-and-value-maps.md): `asValue(key, override)`.
- [Principal factory](09-principal-factory.md): builds principals whose `identity` is your model.
