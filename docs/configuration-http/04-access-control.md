# Access control

Configuration values can hold secrets, so every route is guarded by `@spinajs/authz`. The package declares two permissions with field sets, an admin-only role, and registers `DbConfig` as the `configuration` access resource so ORM queries on it are checked too.

## How it works

1. **Config fragment.** The package config declares `configuration:read` (`fields`, `list`) and `configuration:update` (`fields`), the role `admin.configuration` that grants both, and adds it to `admin` through `extends`.
2. **Boot.** `ConfigurationHttpBootstrapper.bootstrap()` runs with the other bootstrappers, before the authz domain boots:
   - `registerAccessResource(DbConfig, 'configuration')` makes `DbConfig` an access resource. Multi-row selects must use `.accessible()`, `.unscoped()` or `runAs(SYSTEM)`.
   - `requireSystemPrincipal()` opts the root domain in: `@spinajs/configuration-db-source` then persists exposed options and runs the watch poll as `SYSTEM`, after the root authz service boots.
3. **Route check.** `@Access(permission, { fields: 'filter' })` on each route: 401 without a principal, 403 without the permission at type level.
4. **Row check.** The list uses `.accessible('configuration:read')`. A single entry is loaded as `SYSTEM` and checked with `authz().can(caller, permission, { type: 'configuration', id }, entry)`; a refusal answers 404.
5. **Fields.** `fields: 'filter'` limits the response to the decision's `fields.read` and the `PATCH` body to `fields.write`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.permissions.configuration:read` | permission definition | `{ fields: true, list: true }` | see authz | Read entries; usable in `.accessible()` lists; grants may carry a field set. |
| `authz.permissions.configuration:update` | permission definition | `{ fields: true }` | see authz | Change `Value`, `Default`, `Watch`; grants may carry a field set. |
| `authz.rbac.roles.admin.configuration` | role | `{ assignable: false, grants: ['configuration:read', 'configuration:update'] }` | — | Holds both permissions; exists only to be extended. |
| `authz.rbac.roles.admin.extends` | `string[]` | adds `'admin.configuration'` | role names | `admin` gets configuration management. Config merge concatenates `extends` arrays. |

```ts
export default {
  authz: {
    permissions: {
      'configuration:read': { fields: true, list: true },
      'configuration:update': { fields: true },
    },
    rbac: {
      roles: {
        'admin.configuration': { assignable: false, grants: ['configuration:read', 'configuration:update'] },
        admin: { extends: ['admin.configuration'] },
      },
    },
  },
};
```

No other role gets access.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ConfigurationHttpBootstrapper` | `Bootstrapper` (`@Injectable(Bootstrapper)`), singleton, resolved as a list with `Array.ofType(Bootstrapper)` at app start | `ConfigurationHttpBootstrapper` | None | Not meant to be replaced: without it every `DbConfig` select is unchecked and the db-source poll runs without `SYSTEM`. Add your own `Bootstrapper` next to it for more registrations. |
| Roles | `authz.rbac.roles` config | `admin.configuration`, extended by `admin` | Your roles | Extend `admin.configuration`, or grant one permission with a `fields` set. |
| Policies | `authz.abac.policies` config | none | Your policies | Deny or permit per row with `resource.*` conditions; the row is passed to every single-entry check. |
| `ConfigWriteRefused` | Exported error, `Forbidden` (403) | — | — | Thrown by `PATCH` and `ConfigFileUploads.commit` when the update matched no row. |

### Roles: custom grants

Grant configuration access to roles other than `admin` in your app config. A role that extends `admin.configuration` gets full access; a role with a field set sees only what it lists.

```ts sample
export default {
  authz: {
    rbac: {
      roles: {
        // operations staff change every option
        ops: { extends: ['admin.configuration'] },
        // support sees which options exist and their labels, never the values
        support: {
          grants: [
            { permission: 'configuration:read', fields: { read: ['Id', 'Slug', 'Group', 'Type', 'Label', 'Description'] } },
          ],
        },
        // release managers flip feature flags: they may write Value and Watch, not Default
        'release.manager': {
          grants: [
            'configuration:read',
            { permission: 'configuration:update', fields: { write: ['Value', 'Watch'] } },
          ],
        },
      },
    },
  },
};
```

### Policies: lock a group of entries

An ABAC deny on `configuration:update` with a `resource.*` condition is decided on the loaded row, so `PATCH` refuses it with 404 and `ConfigFileUploads` callers that check the row get a refusal too.

```ts sample
export default {
  authz: {
    abac: {
      policies: [
        {
          id: 'payments-config-frozen',
          effect: 'deny',
          permissions: ['configuration:update'],
          resourceTypes: ['configuration'],
          when: { attr: 'resource.Group', eq: 'payments' },
          reason: 'config_frozen',
        },
      ],
    },
  },
};
```

## Important behaviour

- A request without a principal is 401 on every route; a route check failure is 403; a row check failure is 404.
- `PATCH` checks `configuration:read` **and** `configuration:update` on the row. Update without read answers 404.
- The `PATCH` response is filtered by the `fields.read` of the update decision, not of the read grant.
- A body field outside `fields.write` is stripped, or answered with 400 when `authz.fields.write.mode` is `reject`.
- A list call by a principal whose read grant has a row condition the model cannot turn into a list plan fails with 403.
- `ConfigFileUploads.commit` does no authz check of its own; the ORM guard can still refuse the write (`ConfigWriteRefused`). Guard your upload route with `@Access('configuration:update')` and check the row.
- `registerAccessResource` must run before the authz domain boots; a type registered later makes every query on it throw.

## Best practices

- Hide `Value`, `Default` and `Meta` from roles that only need to know which options exist.
- Keep `admin.configuration` non-assignable and extend it from your own roles, as `admin` does.
- In your own controllers, load `DbConfig` rows as the package does: `runAs(SYSTEM, reason)` for the load, then `authz().can()` / `assert()` on the row.

## Patterns and antipatterns

```ts
// Don't: an unscoped multi-row select on DbConfig. In the test env the ORM guard throws; in production it leaks rows.
const all = await DbConfig.where('Group', 'mail');

// Do: scope the list to the caller's read grant.
const visible = await DbConfig.where('Group', 'mail').accessible('configuration:read');
```

## Examples

### Check a principal before reading a secret entry in a job

```ts sample
import { SYSTEM, authz } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DbConfig } from '@spinajs/configuration-db-source';

export async function readEntryFor(caller: Principal, slug: string): Promise<DbConfig | null> {
  const service = authz();
  const entry = await service.runAs(SYSTEM, 'report-job:load-config', async () => DbConfig.where('Slug', slug).first());
  if (!entry) return null;
  const allowed = await service.can(caller, 'configuration:read', { type: 'configuration', id: String(entry.Id) }, entry);
  return allowed ? entry : null;
}
```

## Related

- [Configuration API](01-configuration-api.md): the routes these checks guard.
- [`@spinajs/authz`](../authz/04-host-boot-and-configuration.md#configuration): permission definitions, field sets and config merging.
- [RBAC model](../authz-rbac/README.md) and [ABAC model](../authz-abac/README.md): role and policy syntax.
- [ORM adapter](../authz-orm/README.md): `registerAccessResource`, `.accessible()`, the ORM guard.
- [`@spinajs/configuration-db-source`](../configuration-db-source/README.md): `requireSystemPrincipal()` and the watch poll.
