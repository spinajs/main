# The tenant table

`@spinajs/tenancy-orm` keeps tenants in the table `tenants` and serves it as the tenant registry.

```json
{ "tenancy": { "registry": "DbTenantRegistry" } }
```

## The table

The migration `Tenants_2026_11_16_00_00_00` creates it on the connection alias `tenancy`, which is the default
connection unless the application maps it:

```json
{ "db": { "Aliases": { "tenancy": "control" } } }
```

| Column | Type | Meaning |
|---|---|---|
| `id` | `varchar(64)`, primary key | the tenant id: 1 to 64 characters of `[a-z0-9_-]`, never reused |
| `slug` | `varchar(64)`, unique | display identifier, may change |
| `name` | `varchar(128)` | display name |
| `state` | `varchar(16)` | `provisioning`, `active`, `suspended`, `deleting` or `deleted` |
| `domains` | `text` | the tenant's host names, lower-case, comma-joined |
| `placement` | `text`, nullable | JSON, `{ "kind": "schema", "schema": "..." }` |
| `settings` | `text` | JSON object |
| `created_at`, `updated_at` | `datetime` | |

`id`, `slug` and `domains` compare case-sensitively on every database. Importing `@spinajs/tenancy-orm` registers the model and
the migration, so the table is created with the application's other migrations, also when the registry in use is
another one.

`TenantModel` is a shared table, not a tenant model: it is never declared with `@Tenant()`. Code running inside one
tenant can read every tenant's row through it. Nothing in the package exposes the table to a request; an application
that serves tenant data over HTTP must not hand out `TenantModel` rows itself.

## Lookups

`DbTenantRegistry` implements `TenantRegistry`:

- `get(id)` reads one tenant; a value that is not a tenant id finds nothing.
- `find({ slug })` and `find({ domain })` read one tenant. With both, the slug decides and the domain is not checked,
  where `ConfigTenantRegistry` requires both to match; `admitTenant` always passes one of them. Both are compared for
  equality, never as a pattern or a suffix: `evil-acme.example` does not find the tenant of `acme.example`. A domain is
  trimmed and compared in lower case; a value that is not a host name finds nothing. The table does not make a domain
  unique: when two tenants list one domain, `find` throws.
- `list({ states })` yields every tenant in id order, 200 rows a page.

A row the registry cannot read is never handed out: an id that is not a tenant id, an unknown `state`, a `placement`
other than `null` or a schema placement and a `settings` value that is not an object throw `InvalidOperation`, and JSON
that does not parse fails the lookup. `admitTenant` of `@spinajs/tenancy` then refuses the tenant instead of admitting it.

These statements run in any tenant scope, and with none: the tenant table is where a scope is looked up.

## States

```
provisioning -> active <-> suspended -> deleting -> deleted
provisioning -> deleting                 (a provisioning that did not finish)
```

```ts
import { DI } from '@spinajs/di';
import { TenantStateService } from '@spinajs/tenancy-orm';

const states = await DI.resolve(TenantStateService);
await states.transition('t1', 'suspended');
```

`transition` throws `TenantUnavailable` for an unknown tenant, `InvalidOperation` for a step the machine does not have,
and `ConcurrencyConflict` when the tenant left its state while the call was running: the update names the old state in
its condition, so of two concurrent moves from one state only one changes the row. A row the registry cannot read is still moved,
so that a broken tenant can be suspended or deleted; `transition` then throws `InvalidOperation` when it reads the row
back, after it dropped the tenant from the cache.

`@spinajs/tenancy` reads `DbTenantRegistry` through a cache (`tenancy.registryCacheMs`, 5000 by default). A successful
`transition` drops the tenant from that cache, so the replica that made the change sees it at once; other replicas see
it when their entry expires. A row changed past the service is seen after the same delay, or at once after
`(await tenantRegistry()).invalidate(id)`.
