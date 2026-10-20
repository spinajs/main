# Declaring permissions

A permission is a name `resource:action`, such as `invoice:approve`. Every permission a check names must be registered in the domain's permission registry first; an unknown name is an error, not a "no" (B02). This page shows how to add one so an app can grant it and check it.

## How it works

1. **Name it.** Each part matches `[A-Za-z][A-Za-z0-9_.-]*`: `invoice:approve`, `user.metadata:read`, `ArrowCampaign:update`. Case is kept and compared exactly (H17).
2. **Declare it.** At boot, `DefaultAuthzService` fills a `PermissionRegistryImpl` from four sources, in this order:
   1. the parent domain's registrations (a child domain sees its parent's permissions);
   2. the config, `authz.permissions` in the root domain or `authz.domains.<name>.permissions` in another, with source `config`;
   3. `ResourceAdapter.permissions()` of each adapter registered in the domain's own container, with source `adapter:<kind>`;
   4. `ctx.registerPermissions(defs)` in each model's `init(ctx)`, with source `model:<name>`.
3. **Merge.** A name declared by several sources becomes one definition: `types` and `implies` are unioned, `fields` and `list` are true when any source says so, `consistency: 'fresh'` wins over `'cached'`, the first `description` stays, and `source` lists every source.
4. **Freeze.** `registry.freeze()` refuses a permission whose `implies` names an unregistered one (`UnknownPermission`). Nothing can register after boot: a model that calls `registerPermissions` after its `init` returned gets `AuthzConfigError`.
5. **Validate.** The boot checks run over the frozen registry ([Host, boot and configuration](04-host-boot-and-configuration.md#boot-checks)): rule 7 for `implies` and the permissions packages reference, rule 12 for `list: true` permissions.
6. **Grant.** A registered permission is still denied to everyone until a model grants it: an RBAC role grant or an ABAC permit policy.
7. **Check.** `authz().can(...)`, `assert(...)`, `@Access(...)` or `.accessible(...)` name it ([Checking permissions](03-checking-permissions.md)).

## Permission definition

`PermissionDef`, the registered form:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | required | `resource:action`. |
| `resource`, `action` | `string` | parsed from `name` | Given in a definition, each must match the name, or registration fails. |
| `types` | `string[]` | `[resource]` | Resource types the permission may be checked on. `$global` is always allowed. A check on another type throws `AuthzConfigError`. |
| `implies` | `string[]` | none | Permissions this one implies. Each must be registered by freeze time. `PermissionRegistry.impliedBy(name)` lists the permissions that imply `name`, transitively. <!-- TODO(docs-hook): verify whether RbacModel and AbacModel honour implies when they grant --> |
| `fields` | `boolean` | unset | Grants and policies of this permission may carry field sets. |
| `list` | `boolean` | unset | The permission has an access plan: `.accessible()` and `accessPlan()` need it. Boot rule 12 refuses one that a routed model can grant only by reading the row. |
| `consistency` | `'cached'`, `'fresh'` | `'cached'` | `'fresh'`: every check skips the decision caches and the models' assignment caches. |
| `description` | `string` | none | Free text. |
| `source` | `string` | set by the registry | `config`, `adapter:<kind>`, `model:<name>`, joined with `,` when merged. |

### Globs

Grants, policies, rules and ceilings name permissions by glob; checks never do.

| Glob | Matches |
| --- | --- |
| `*` | every permission |
| `user:*` | every action on `user` |
| `user.*:read` | `read` on `user.metadata`, `user.profile`, ... |
| `*:read` | `read` on every resource |

A `*` matches any run of characters within its part; it never crosses the `:`. `**` is invalid. `isPermissionGlob()`, `compilePermissionGlob()` and `matchesPermission()` apply the same rules in app code.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.permissions.<name>` | `object` | none | a permission name as key | Declares `<name>` in the root domain. |
| `authz.permissions.<name>.types` | `string[]` | `[resource]` | resource types | See `types` above. |
| `authz.permissions.<name>.implies` | `string[]` | none | permission names | See `implies` above. |
| `authz.permissions.<name>.fields` | `boolean` | unset | | See `fields` above. |
| `authz.permissions.<name>.list` | `boolean` | unset | | See `list` above. |
| `authz.permissions.<name>.consistency` | `string` | `'cached'` | `'cached'`, `'fresh'` | See `consistency` above. |
| `authz.permissions.<name>.description` | `string` | none | | Free text. |
| `authz.domains.<domain>.permissions.<name>` | `object` | none | as above | Declares `<name>` in one domain and its children, on top of the parent's. |

```ts
export default {
  authz: {
    permissions: {
      'invoice:read': { list: true, fields: true },
      'invoice:approve': { description: 'Approve an invoice for payment' },
      'invoice:delete': { consistency: 'fresh' },
      'report:export': { types: ['report', 'project'] },
    },
  },
};
```

Packages declare their own permissions; an app declares the rest. `AuthzAdmin` needs `authz:*` permissions that the core does not register ([AuthzAdmin](10-authz-admin.md#permissions)).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `PermissionRegistry` | not in DI; one per domain, built at boot and frozen | `PermissionRegistryImpl` | none | Read it as `ctx.permissions` in a model. Add permissions through config, an adapter's `permissions()` or a model's `ctx.registerPermissions()`. |
| `AuthzContributor` | `AuthzContributor`, every registration of the container chain | several packages ship one | your own | Return `permissionRefs` so boot fails when a permission your package checks is missing ([Resource adapters and resolvers](09-adapters-and-resolvers.md#contributors)). |

### A model that brings its own permissions

A model registers the permissions it knows about in `init`, so an app does not have to declare them:

```ts
init(ctx: ModelInitContext): void {
  ctx.registerPermissions([
    { name: 'invoice:approve', description: 'Approve an invoice for payment' },
    { name: 'invoice:read', list: true },
  ]);
}
```

`init` runs once per model instance, in the first domain that lists it. Other domains that list the same instance get its registrations replayed.

## Important behaviour

- **An unknown permission throws.** `check`, `can` and `assert` throw `UnknownPermission` (an `AuthzConfigError`); only `checkAll` turns it into a denial with `invalid_request`.
- **A permission no model grants is denied to everyone**, `SYSTEM` excepted. Registration says "this name exists", not "someone has it".
- **Types bound checks.** `invoice:approve` is checked on `invoice` refs and `$global` only, unless `types` widens it.
- **The registry is per domain.** A child domain sees its parent's permissions plus its own; the parent never sees a child's.

## Best practices

- Name the resource part after the resource type the check runs on (`task:update` on `{ type: 'task' }`), so the default `types` is right.
- Declare `list: true` only for permissions a list query uses; boot rule 12 then proves every routed model can plan it.
- Use `consistency: 'fresh'` for deletes, sharing, payouts and admin actions: a role revoked on another node is never honoured from a cache. Every fresh check reads the store.

## Patterns and antipatterns

```ts
// Don't: a glob in a check is not a permission name; the check throws AuthzConfigError
await authz().can(me, 'invoice:*', { type: 'invoice', id });

// Do: check the one action the code is about to perform
await authz().can(me, 'invoice:approve', { type: 'invoice', id });
```

## Examples

### Add an approval permission for invoices

Declare the permission, grant it, then check it before the approval runs.

```ts
// config/authz.ts
export default {
  authz: {
    permissions: { 'invoice:approve': { description: 'Approve an invoice for payment' } },
    // Granted by an RBAC role; see the authz-rbac docs for roles and grants.
    rbac: { roles: { accountant: { grants: ['invoice:approve'] } } },
  },
};
```

```ts sample
import { authz } from '@spinajs/authz';

export async function approveInvoice(invoiceId: string): Promise<void> {
  const me = authz().current();
  // Throws AccessDenied (403) with the decision when the caller may not approve.
  await authz().assert(me, 'invoice:approve', { type: 'invoice', id: invoiceId });
  // ... mark the invoice approved
}
```

## Related

- [Checking permissions](03-checking-permissions.md): every way to check a registered permission.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): roles and grants of permissions ([Roles and permissions](../authz-rbac/03-roles-and-permissions.md)).
- [`@spinajs/authz-abac`](../authz-abac/README.md): permit and deny policies over permission globs.
- [`@spinajs/authz-orm`](../authz-orm/README.md): the permissions of `@AccessResource` models and `list: true` lists.
- [`@spinajs/authz-convert`](../authz-convert/README.md): turns 2.x grants into permissions and roles.
