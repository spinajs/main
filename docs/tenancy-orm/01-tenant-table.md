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

The index `tenants_state` covers `state`. `TENANTS_TABLE` and `TENANCY_CONNECTION` export the table name and the
connection alias.

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

`toTenantRecord(row)` is the conversion the registry uses, with the same checks, for code that reads `TenantModel`
rows itself.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `DbTenantRegistry` | `TenantRegistry`, `@Injectable` at import; chosen by `tenancy.registry` | `ConfigTenantRegistry` of `@spinajs/tenancy` | `DbTenantRegistry` | Set `tenancy.registry: 'DbTenantRegistry'`; subclass it to override `byDomain(domain)` or `pageSize` (200) |
| `TenantStateService` | `TenantStateService`, `@Injectable()` | itself | none | Subclass and register with `DI.register(MyStates).as(TenantStateService)`; `current(id)` reads the row |
| `TenantSettingsService` | `TenantSettingsService`, `@Injectable()` | itself | none | Subclass and register with `DI.register(MySettings).as(TenantSettingsService)`; `current(id)` reads the row |

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

`nextStates(from)` lists the states a tenant may move to, `canTransition(from, to)` checks one step, and
`isTenantState(value)` checks a value.

`transition` throws `TenantUnavailable` for an unknown tenant, `InvalidOperation` for a step the machine does not have,
and `ConcurrencyConflict` when the tenant left its state while the call was running: the update names the old state in
its condition, so of two concurrent moves from one state only one changes the row. A row the registry cannot read is still moved,
so that a broken tenant can be suspended or deleted; `transition` then throws `InvalidOperation` when it reads the row
back, after it dropped the tenant from the cache.

`@spinajs/tenancy` reads `DbTenantRegistry` through a cache (`tenancy.registryCacheMs`, 5000 by default). A successful
`transition` drops the tenant from that cache, so the replica that made the change sees it at once; other replicas see
it when their entry expires. A row changed past the service is seen after the same delay, or at once after
`(await tenantRegistry()).invalidate(id)`.

## Writing a tenant's settings

```ts
import { DI } from '@spinajs/di';
import { TenantSettingsService } from '@spinajs/tenancy-orm';

const settings = await DI.resolve(TenantSettingsService);
await settings.set('acme', 'mail.from', 'billing@acme.example');   // stored as { mail: { from: ... } }
await settings.unset('acme', 'mail.from');
```

`set(id, path, value)` and `unset(id, path)` write a tenant's [configuration overrides](../tenancy/07-configuration-overrides.md)
and return the tenant record as the registry reads it. Whoever may call them can change, for that tenant, every path the
application lists; guard the route or command that calls them.

- `path` must be one of the paths `tenancy.config.overridable` lists, exactly. Any other path, a free-form key such as
  `plan`, a parent or a child of a listed path and every path under a closed root (`db`, `authn`, `tenancy`, ...) are
  refused with `InvalidArgument` before the row is read. To change one key of a listed object, `set` the whole object.
  Free-form settings are written at provisioning or through `TenantModel`.
- The value is checked in its JSON form, the form the `settings` column stores (a `Date` becomes its ISO text, an
  `undefined` key is left out); a value without one (`undefined`, a function, a cycle) is refused with `InvalidArgument`.
- `checkTenantSettings` checks the whole resulting settings object: every value at a listed path must pass the
  configuration schema and hold no `__proto__`, `constructor` or `prototype` key at any depth. A refusal throws
  `InvalidConfiguration` and writes nothing: the row is written in one statement or not at all. A value stored before at
  another listed path that the schema now refuses makes every `set` fail until it is `unset`.
- **A listed path that no configuration schema declares is stored as written**, unchecked apart from the reserved keys,
  and the overlay serves it as stored. List only paths a schema declares.
- Inside a tenant scope only that tenant's settings are written; another id throws `TenantMismatch`. With no scope and
  across all tenants (`runAcrossTenants`) the call writes the tenant it names: that is the platform's form.
- An unknown tenant throws `TenantUnavailable`; a tenant in any state can be written.

After the write the service drops the tenant from the registry cache and loads its settings again, so the next read in
this process answers the new value. Other processes see it once their copy is older than `tenancy.registryCacheMs`
(5000 by default): a request, which admits the tenant, after at most `tenancy.registryCacheMs`; code that reads without
admitting gets the old value at the first read past that interval, which starts the refresh, and the new one after it,
at most about twice the interval after the write. A failed refresh keeps the last settings and is tried again one
`tenancy.registryCacheMs` later. With `tenancy.registryCacheMs: 0` only an admission or `loadTenantSettings` reads them again.

Two writes of one tenant at the same time: the last one wins for the whole settings object. Each stored object is
the complete result of one call and passed the check, but the change of the other call can be lost.

## Related

- [Tenant models](02-tenant-models.md): confine the rows of the tenants this table lists.
- [`@spinajs/orm`](../orm/01-connections.md): the migration and the `db.Aliases` mapping of the `tenancy` connection.
