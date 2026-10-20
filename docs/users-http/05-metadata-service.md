# Metadata service

`UserMetadataService` reads and writes one user's metadata inside a `MetadataScope`: the owner, and a callback that admits or refuses each row. The metadata routes are thin wrappers around it. Reuse it in your own routes and jobs, subclass it to add rules, or replace it.

## How it works

1. A caller builds a `MetadataScope`:
   - `ownMetadata(req, user)`: the `@CurrentUser()` row is the owner; admission follows the route's `@Access` decision.
   - `addressedMetadata(req, uuid)`: the user `uuid` is the owner; a conditional decision on another user is refused with `403`, a missing user is `404`.
   - Your own object: `{ ownerId, admits(permission, row) }`.
2. The service limits every query to `user_id = scope.ownerId`.
3. It runs reserved-key checks on the key sent **and** on the key of each stored row the database returns.
4. For each row it reads or writes, it calls `scope.admits(permission, row)`; `false` throws `Forbidden` (`403`).
5. It runs the query: `select`, `insert(InsertOrUpdate)`, `update ... where Id and user_id`, or `destroy(Id) ... and user_id`.

### The scopes of `ownMetadata` and `addressedMetadata`

`admits(permission, row)`:

1. answers `true` without a check when the route's decision is unconditional (residual `true`) and `permission` is the route's own permission;
2. otherwise calls `AuthzService.check({ principal, permission, resource: { type: 'user.metadata' }, subject: row })` as the caller, and answers `allowed`.

Both throw `Forbidden` when the request carries no allowed `@Access` decision (`req.storage.AuthzDecision`): they serve only routes their policy allowed.

## API

| Member | Signature | Result and errors |
| --- | --- | --- |
| `list` | `list(scope, pagination?, order?, filter?)` | Entries the caller may read, reserved keys left out. `limit` defaults to `DEFAULT_PAGE_SIZE` (`10`) and is capped at `MAX_PAGE_SIZE` (`100`); `order.column` other than `Id`, `Key`, `Type` throws `InvalidArgument` (`400`). |
| `getByKey` | `getByKey(scope, key): Promise<UserMetadataBase>` | One entry. `404` when absent or reserved, `403` when not admitted for `user.metadata:read`. |
| `upsert` | `upsert(scope, dto: UserMetadataDto): Promise<void>` | Insert, or update an existing key. `400` for a reserved key; `403` without `update` on each stored twin or `create` on the new entry. |
| `update` | `update(scope, idOrKey, dto): Promise<void>` | Update the entry addressed by `Id` (digits) or `Key`. `404` absent or reserved; `400` for a reserved new key; `403` without `update` on the stored and on the resulting entry. |
| `delete` | `delete(scope, id: number): Promise<void>` | Delete by `Id`. `404` absent or reserved; `403` without `user.metadata:delete`. |
| `addressedColumn` | `addressedColumn(idOrKey): 'Id' \| 'Key'` | `'Id'` for a number or an all-digit string, else `'Key'`. |
| `ownMetadata` | `ownMetadata(req, user): MetadataScope` | Scope of the signed-in user. |
| `addressedMetadata` | `addressedMetadata(req, uuid): Promise<MetadataScope>` | Scope of user `uuid`. |

`MetadataScope`:

| Member | Type | Meaning |
| --- | --- | --- |
| `ownerId` | `number` (readonly) | `users.Id` of the owner; every query is limited to it |
| `admits(permission, row)` | `(permission: Permission, row: object) => Promise<boolean>` | Whether the caller may apply `permission` to `row`: a stored entry, or the entry a write would leave |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `UserMetadataService` | Class key `UserMetadataService`, `@Injectable()`; singleton; `@Autoinject(UserMetadataService)` into `UserMetadataController` when the controller is built | `UserMetadataService` | none | Subclass it, override `list`, `getByKey`, `upsert`, `update` or `delete`, and `DI.register(Mine).as(UserMetadataService)` before the controllers resolve (before the HTTP server starts). The row helpers are private: call `super`. |
| `MetadataScope` | Interface, no DI | `ownMetadata()`, `addressedMetadata()` | yours | Implement `{ ownerId, admits }` to run the service outside a request, or with your own admission rule. |

### `UserMetadataService`: allow only namespaced keys

Your clients may write only keys under `app:` and `ui:`, plus `user:niceName`, which the admin user list filters on. Override the two write methods, check the key, then call `super`: the reserved-key, ownership and per-row checks still run.

```ts sample
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { MetadataScope, UserMetadataDto, UserMetadataService } from '@spinajs/users-http';

const WRITABLE = [/^app:/, /^ui:/, /^user:niceName$/];

export class NamespacedMetadataService extends UserMetadataService {
  public async upsert(scope: MetadataScope, data: UserMetadataDto): Promise<void> {
    this.assertWritable(data.Key);
    return super.upsert(scope, data);
  }

  public async update(scope: MetadataScope, idOrKey: string | number, data: UserMetadataDto): Promise<void> {
    this.assertWritable(data.Key);
    return super.update(scope, idOrKey, data);
  }

  protected assertWritable(key: string): void {
    if (!WRITABLE.some((rule) => rule.test(key))) {
      throw new InvalidArgument(`metadata key ${key} is not writable through the API`, 'Key');
    }
  }
}

// Before the HTTP server starts: UserMetadataController receives the service when it is built.
DI.register(NamespacedMetadataService).as(UserMetadataService);
```

### `MetadataScope`: write metadata from a background job

A job has no request and no `@Access` decision. Build the scope yourself. The service still refuses reserved keys, whatever `admits` answers.

```ts sample
import { DI } from '@spinajs/di';
import { userModel } from '@spinajs/users';
import { MetadataScope, UserMetadataDto, UserMetadataService } from '@spinajs/users-http';

/** Copies display names from a legacy import into user metadata. Trusted code: every row is admitted. */
export async function importDisplayNames(rows: Array<{ login: string; displayName: string }>): Promise<number> {
  const metadata = (await DI.resolve(UserMetadataService)) as UserMetadataService;
  let written = 0;

  for (const row of rows) {
    const user = await userModel().query().where('Login', row.login).first();
    if (!user) {
      continue;
    }

    const scope: MetadataScope = { ownerId: user.Id, admits: async () => true };
    await metadata.upsert(scope, new UserMetadataDto({ Key: 'user:niceName', Value: row.displayName, Type: 'string' }));
    written++;
  }

  return written;
}
```

## Important behaviour

- `list` excludes reserved rows in the query, so a page holds `limit` visible entries; it then drops entries `admits` refuses. With a conditional grant, a page can hold fewer than `limit` entries.
- `upsert` takes the DTO, not a model: the owner comes from the scope only.
- `update` compares one column chosen by `addressedColumn()`; a key that is all digits cannot be addressed by key.
- `Value` is assigned before `Type`: the model's `Value` setter derives `Type` from the JS type, and the declared type must win.
- `UserMetadataService` adds no model scope to its queries; it decides each row through `admits`. A scope that answers `true` for everything is trusted code.

## Best practices

- Build scopes with `ownMetadata()` and `addressedMetadata()` in routes; they read the route's decision, so a conditional grant is decided per row.
- Keep `admits: async () => true` to jobs, migrations and CLI commands; never build it from request input.
- Call `super` in overrides: the reserved-key and ownership checks live in private helpers you cannot reach otherwise.

## Patterns and antipatterns

```ts
// Don't: query users_metadata directly in a route. Nothing hides reserved keys or decides each row.
const rows = await UserMetadata.where('user_id', user.Id);

// Do
const rows = await this.Metadata.list(ownMetadata(req, user));
```

## Examples

### Return the signed-in user's UI preferences

```ts sample
import { BaseController, BasePath, Get, Ok, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Autoinject } from '@spinajs/di';
import { Access } from '@spinajs/authz-http';
import { FilterableLogicalOperators, PaginationDTO } from '@spinajs/orm-http';
import type { User } from '@spinajs/users';
import { CurrentUser, UserMetadataService, ownMetadata } from '@spinajs/users-http';

@BasePath('me')
export class PreferencesController extends BaseController {
  @Autoinject(UserMetadataService)
  protected Metadata: UserMetadataService;

  /** GET /me/preferences: every `ui:` entry of the caller, as one object. */
  @Get('preferences')
  @Access('user.metadata:read')
  public async preferences(@Req() req: Request, @CurrentUser() user: User) {
    // e-like is "starts with": Key LIKE 'ui:%'.
    const rows = await this.Metadata.list(ownMetadata(req, user), new PaginationDTO({ limit: 100 }), undefined, {
      op: FilterableLogicalOperators.And,
      filters: [{ Column: 'Key', Operator: 'e-like', Value: 'ui:' }],
    });

    return new Ok(Object.fromEntries(rows.map((r) => [r.Key.slice('ui:'.length), r.Value])));
  }
}
```

## Related

- [User metadata routes](04-user-metadata-routes.md): the routes built on this service.
- [Current user argument](02-current-user.md): the row `ownMetadata()` takes.
- [Filtering](../orm-http/03-filtering.md): the filter request `list` accepts.
- [`@spinajs/users`](../users/README.md): `UserMetadataBase` and `isReservedMetadataKey()`.
