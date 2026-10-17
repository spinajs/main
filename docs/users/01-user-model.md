# User model and metadata

`User` is the ORM model of one account in the `users` table; `UserMetadata` holds its key-value extras in `users_metadata`. Use the model for reads and queries; use the [user actions](03-user-actions.md) for anything that changes account state.

## How it works

1. `User` extends `UserBase`, both `@Connection('default')` and `@Model('users')`. `UserBase` carries the columns, the `Metadata` relation, the query scopes and the static getters; `User` exists so an application can subclass `UserBase` or `User` and keep the same table (see [Custom user model](02-custom-user-model.md)).
2. The constructor fills `Uuid` with a new UUID v4 when the data does not carry one.
3. `Metadata` is a `@HasMany(UserMetadataBase, { foreignKey: 'user_id' })` metadata relation. Read and write it like an object: `user.Metadata['user:phone'] = '+48...'`, then `await user.Metadata.update()`. Value types (`number`, `float`, `string`, `json`, `boolean`, `datetime`) are stored in the `Type` column and converted back on read.
4. `IsBanned` reads the ban metadata: `user:ban:is_banned` must be `true`, and the ban holds until `user:ban:start_date` + `user:ban:duration` seconds. A missing or invalid start or duration means a permanent ban.
5. `dehydrateWithRelations()` (what `toJSON()` and the HTTP layers send) drops `Id`, `Password` and `PasswordSetAt` (`@Hidden()`), and every metadata row whose key is reserved (`isReservedMetadataKey`) or listed in `UserMetadataBase._hiddenKeys`.
6. `RbacBootstrapper` appends `USER_SECURITY_METADATA_KEYS` to `UserMetadataBase._hiddenKeys` when the bootstrappers run, keeping whatever the application put there.

## Model API

### Columns (`UserBase`)

| Property | Type | Notes |
| --- | --- | --- |
| `Id` | `number` | `@Primary()`, `@Hidden()`: never leaves the process. Use `Uuid` outside. |
| `Uuid` | `string` | The public id. authn and authz name a user `user:<Uuid>`. |
| `Email` | `string` | Unique. |
| `Password` | `string` | `@Hidden()`. A hash, authn-local's `'!expired'` marker, or `NO_PASSWORD` (`'!none'`) for an invited account. |
| `Login` | `string` | Unique display name. |
| `CreatedAt` | `DateTime` | `@CreatedAt()`. |
| `RegisteredAt` | `DateTime` | `@DateTime()`. Set by `create()`. |
| `PasswordSetAt` | `DateTime` | `@DateTime()`, `@Hidden()`. When the current password was set; written by [`UserAccountSink`](08-authn-event-sinks.md). |
| `DeletedAt` | `DateTime` | `@SoftDelete()`. Normal reads skip soft-deleted rows; add `.withDeleted()` to see them. |
| `LastLoginAt` | `DateTime` | `@DateTime()`. No package in this monorepo writes it; see [Authn event sinks](08-authn-event-sinks.md#custom-sink-stamp-the-last-login-time). |
| `IsActive` | `boolean` | Account passed registration. Independent of a ban. |
| `Metadata` | `MetadataRelation<UserMetadataBase, User>` | Key-value extras. |
| `IsBanned` | `boolean` (getter) | Ban state from metadata, duration aware. |

### Static getters

Each builds its query from the receiving class (`this.query()`), so a subclass registered as the user model gets its own scopes and hooks. Each resolves `undefined` when nothing matches.

| Method | Finds by |
| --- | --- |
| `User.getByLogin(login)` | `Login` |
| `User.getByEmail(email)` | `Email`; the argument must be an email |
| `User.getByUuid(uuid)` | `Uuid`; the argument must be a UUID |
| `User.getByAnything(identifier)` | `whereAnything(identifier)` |

### Query scopes (`UserQueryScopes`)

Available on `User.query()`, `User.where(...)`, `User.update(...)` and `User.destroy(...)`.

| Scope | Effect |
| --- | --- |
| `whereAnything(identifier)` | A number, or a string of digits only, matches `Id`. Any other string matches `Uuid`, `Email` or `Login`. |
| `whereUuid(uuid)` | `Uuid = uuid`; throws on a non-UUID. |
| `whereEmail(email)` | `Email = email`; throws on a non-email. |
| `whereLogin(login)` | `Login = login`. |
| `whereUser(userOrEmail)` | `Email` of the given `User`, or the given string. |
| `whereMetadata(key, value)` | Users with a metadata row `Key = key AND Value = value`. `Value` is the stored text, so pass `'true'` for a boolean. |
| `isActiveUser()` | `IsActive = true AND DeletedAt IS NULL`. It does **not** filter banned users. |
| `notDeleted()` | `DeletedAt IS NULL`. |
| `checkIsBanned()` | Async. Runs a count and answers whether any matched user has `user:ban:is_banned = 'true'`. Ignores the ban duration. |
| `checkIsActive()` | Async. Answers whether any matched user has `IsActive = true`. |

### Metadata keys (`USER_COMMON_METADATA`)

| Key | Constant | Written by |
| --- | --- | --- |
| `user:ban:is_banned` | `USER_BAN_IS_BANNED` | `ban()`; removed by `unban()` |
| `user:ban:start_date` | `USER_BAN_START_DATE` | `ban()` |
| `user:ban:duration` | `USER_BAN_DURATION` | `ban()`, in seconds |
| `user:ban:reason` | `USER_BAN_REASON` | `ban()` |
| `user:avatar`, `user:phone`, `user:newsletter:enabled` | `USER_AVATAR`, `USER_PHONE`, `USER_NEWSLETTER_ENABLED` | your application |
| `user:2fa:token` | `USER_2FA_TOKEN` | legacy; reserved |
| `user:pwd:reset`, `user:pwd_reset:*` | `USER_PWD_RESET*` | legacy 2.x reset state; reserved |
| `user:invite:pending` | `USER_INVITE_PENDING` | `create()` without a password; removed on invite redeem, `activate()` and `deactivate()` |
| `user:login:attempts`, `user:login:locked_until` | `USER_LOGIN_ATTEMPTS`, `USER_LOGIN_LOCKED_UNTIL` | legacy throttle state; reserved |

### Reserved keys, logins and markers

| Export | Value | Meaning |
| --- | --- | --- |
| `USER_RESERVED_METADATA_PREFIXES` | `'2fa:'`, `'user:2fa:'`, `'user:pwd_reset:'`, `'user:pwd:'`, `'user:login:'`, `'user:ban:'`, `'user:invite:'` | Account security state. The generic metadata API neither writes nor shows a key under them. |
| `isReservedMetadataKey(key)` | function | Folds the key (NFKD, accents and invisible characters removed, trimmed, lower-cased) and checks the prefixes, so `2FA:Token` and `２fa:token` count. |
| `USER_SECURITY_METADATA_KEYS` | the exact `USER_COMMON_METADATA` security keys | Added to `UserMetadataBase._hiddenKeys` at bootstrap. |
| `NO_PASSWORD` | `'!none'` | `users.Password` of an account without a password. |
| `SYSTEM_LOGIN` | `'__system__'` | Login of the framework's system account. |
| `isReservedLogin(login)` | function | `true` for `__name__` logins (NFKC folded). `create()` and `assertUserUnique()` refuse them. |

## Schema

The migrations run on the `default` connection and are exported, so the ORM finds them by import.

### `users`

| Column | Type | Meaning |
| --- | --- | --- |
| `Id` | `int`, primary key, auto increment | Internal row id. |
| `Uuid` | `string(36)`, not null, unique index `user_uuid_idx` | Public id. |
| `Email` | `string(64)`, not null, unique | Email. |
| `Password` | `string(128)`, not null | Hash or marker. |
| `Login` | `string(64)`, not null, unique index `user_login_idx` | Login. |
| `Role` | `string(256)`, not null | 2.x role column. `@spinajs/authz-rbac` copies it into role assignments and drops it (`AuthzRbacUserRoles_…`, `AuthzRbacDropUserRole_…`). |
| `IsActive` | `boolean`, not null, default `0` | Active flag. |
| `CreatedAt` | `datetime`, not null, default now | Creation time. |
| `DeletedAt` | `datetime`, nullable | Soft delete time. |
| `LastLoginAt` | `datetime`, nullable | Last login. |
| `RegisteredAt` | `datetime`, nullable | Added by `RBACRegisteredAt_2026_07_28_00_00_00`; existing rows stay null. |
| `PasswordSetAt` | `datetime`, nullable | Added by `UsersPasswordSetAt_2026_10_04_00_00_00`; rows holding a password get the migration time. |

### `users_metadata`

| Column | Type | Meaning |
| --- | --- | --- |
| `Id` | `int`, primary key, auto increment | Row id. |
| `Key` | `string(255)`, not null | Metadata key. Unique per user (`owner_user_meta_key_idx` on `user_id`, `Key`). |
| `Type` | `enum('number','float','string','json','boolean','datetime')`, not null | Value type. |
| `Value` | `text` | Serialized value. |
| `user_id` | `int`, not null, foreign key to `users.Id`, cascade | Owner. `@Hidden()` on the model. |

### Migrations

| Class | Effect |
| --- | --- |
| `RBACInitial_2022_06_28_01_13_00` | Creates both tables and their indexes. `down()` does nothing. |
| `RBACRegisteredAt_2026_07_28_00_00_00` | Adds `users.RegisteredAt` unless the column exists. `down()` does nothing. |
| `UsersPasswordSetAt_2026_10_04_00_00_00` | Adds `users.PasswordSetAt` unless it exists, then stamps the migration time on rows that hold a password (not a `!` marker, not empty). `down()` drops the column. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| User model class | `RBAC_USER_MODEL` value in the root cache | `User` | your subclass | See [Custom user model](02-custom-user-model.md). |
| Query scopes | `UserBase._queryScopes`, a `UserQueryScopes` instance | `UserQueryScopes` | your scope class on a subclass | Override in the subclass and redeclare the methods you keep; see [Custom user model](02-custom-user-model.md#add-query-scopes). |
| Hidden metadata keys | `UserMetadataBase._hiddenKeys`, a static array | `USER_SECURITY_METADATA_KEYS` after bootstrap | your keys | Push keys into the array at startup; the bootstrapper keeps them. |
| Bootstrap | `Bootstrapper` list, `RbacBootstrapper` | `RbacBootstrapper` | none | Runs once per bootstrap pass; registers the `authz.http.access` schema, the hidden keys, the default user model and `EmailPasswordMailer`. |

### Hidden metadata keys: hide your own keys

Keys that are internal to your application (a CRM id, a fraud score) stay out of every dehydrated user when you add them to `_hiddenKeys`. The reserved prefixes are always filtered; this list is for your own keys.

```ts sample
import { Bootstrapper, Injectable } from '@spinajs/di';
import { UserMetadataBase } from '@spinajs/users';

const INTERNAL_KEYS = ['crm:contact_id', 'fraud:score'];

@Injectable(Bootstrapper)
export class HideInternalUserMetadata extends Bootstrapper {
  public bootstrap(): void {
    UserMetadataBase._hiddenKeys = [...new Set([...UserMetadataBase._hiddenKeys, ...INTERNAL_KEYS])];
  }
}
```

## Important behaviour

- `whereAnything('123')` looks up `Id = 123`, never a login `123`. A login or UUID that only starts with digits goes to the `Uuid` / `Email` / `Login` branch.
- `isActiveUser()` and `checkIsActive()` ignore bans; `checkIsBanned()` ignores the ban duration. Read `user.IsBanned` for the duration-aware answer.
- An expired ban leaves `user:ban:is_banned` stored until `unban()` removes it. `IsBanned` is `false` for it and `ban()` accepts a new ban.
- `dehydrateWithRelations()` also hides `2fa:enabled` (it is under a reserved prefix). MFA status comes from authn's MFA routes.
- `UserMetadataBase` applies no access check. Callers such as users-http decide each row.
- `RBACInitial` creates `users.Role` as `NOT NULL` with no default. Run the authz-rbac migrations after it, or inserts that omit `Role` fail.

## Best practices

- Identify users by `Uuid` everywhere outside the database. `Id` is hidden on purpose.
- Read users through `userModel()` (or `getUser()`), not `User` directly, so an application's model subclass applies.
- Write ban, invite and reset state only through the actions; the metadata API refuses reserved keys.
- Populate `Metadata` before reading `IsBanned`: `User.query().where(...).populate('Metadata')`.

## Patterns and antipatterns

```ts
// Don't: IsBanned reads metadata; without populate it answers false for a banned user
const user = await User.getByEmail('ada@acme.com');
if (!user.IsBanned) { /* lets a banned user through */ }

// Do
const user = await userModel().query().whereEmail('ada@acme.com').populate('Metadata').firstOrFail();
if (!user.IsBanned) { /* ... */ }
```

## Examples

### List active users subscribed to the newsletter

```ts sample
import { USER_COMMON_METADATA, User, userModel } from '@spinajs/users';

export async function newsletterRecipients(): Promise<string[]> {
  // Values are compared as stored text: a boolean is stored as 'true'.
  const users = (await userModel().query().isActiveUser().whereMetadata(USER_COMMON_METADATA.USER_NEWSLETTER_ENABLED, 'true').populate('Metadata')) as User[];

  return users.filter((u) => !u.IsBanned).map((u) => u.Email);
}
```

### Store a phone number on a user

```ts sample
import { USER_COMMON_METADATA, getUser, setUserMeta } from '@spinajs/users';

export async function savePhone(uuid: string, phone: string): Promise<void> {
  const user = await getUser(uuid);
  await setUserMeta(user, USER_COMMON_METADATA.USER_PHONE, phone);
}
```

## Related

- [Custom user model](02-custom-user-model.md): subclass `User` and register it.
- [User actions](03-user-actions.md): the functions that change account state.
- [Metadata models](../orm/15-metadata-models.md): how the `Metadata` relation reads and writes.
- [Scopes and builder extensions](../orm/16-scopes-and-builder-extensions.md): how `UserQueryScopes` is bound.
- [Migrations](../orm/10-migrations.md): how the shipped migrations run.
