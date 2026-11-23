# Configuration

Everything tenancy reads lives under `tenancy`. This package reads the root keys; `@spinajs/tenancy-http` reads `tenancy.http.*`, whose schema and defaults this package ships.

## How it works

1. Importing the package registers `TENANCY_CONFIGURATION_SCHEMA` (`$id` `spinajs/tenancy.configuration.schema.json`) with `registerConfigurationSchemaAtImport`.
2. When the configuration is not resolved yet, it applies the schema when it boots. When it is already resolved, the schema validates `tenancy` at once: a refused value is logged, and every later read of `tenancy` throws `InvalidConfiguration` until it validates.
3. The package ships no configuration file. An unset key reads as `undefined` from `Configuration`; the code falls back to `TENANCY_DEFAULTS`.
4. `tenancy.registry` and `tenancy.access` are read once per container, when `TenancyServices` resolves. `tenancy.registryCacheMs` is read on every registry lookup. `tenancy.tenants` is parsed again whenever the configured array is replaced.

The schema is open at the root and inside `http`: keys it does not name pass, for the packages that read them.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `tenancy.registry` | string | `'ConfigTenantRegistry'` | non-empty; a class registered under `TenantRegistry` | The tenant registry; see [Tenant registries](03-tenant-registries.md) |
| `tenancy.access` | string | `'PrincipalAttributeTenantAccess'` | non-empty; a class registered under `TenantAccess` | The access check of `admitTenant`; see [Tenant admission and access](04-admission-and-access.md) |
| `tenancy.registryCacheMs` | integer | `5000` | `0` or more | TTL of the registry cache in milliseconds; `0` turns it off. No effect over a registry whose `cacheable` is `false`. |
| `tenancy.tenants` | object[] | `[]` | [tenant entries](#tenant-entries) | The tenants `ConfigTenantRegistry` answers with |
| `tenancy.http.resolvers` | string[] | `['domain', 'subdomain', 'path', 'header', 'principal', 'session']` | names of registered resolvers | Read by `@spinajs/tenancy-http`: the resolvers asked, in order |
| `tenancy.http.header` | string | `'x-tenant'` | non-empty | Read by `@spinajs/tenancy-http`: the header that names a tenant id |
| `tenancy.http.unknownTenant` | integer | `404` | `404`, `403` | Read by `@spinajs/tenancy-http`: the status of a refused tenant |
| `tenancy.http.baseDomains` | string[] | `[]` | host names | Read by `@spinajs/tenancy-http`: the application's own domains |
| `tenancy.http.pathParam` | string | `'tenant'` | non-empty | Read by `@spinajs/tenancy-http`: the route parameter holding a tenant slug |
| `tenancy.http.principalAttribute` | string | `'tenant'` | non-empty | Read by `@spinajs/tenancy-http`: the principal attribute holding a tenant id |
| `tenancy.http.sessionKey` | string | `'tenant'` | non-empty | Read by `@spinajs/tenancy-http`: the session key holding a tenant id |

The `tenancy.http.*` keys are described in [`@spinajs/tenancy-http`](../tenancy-http/README.md).

### Tenant entries

Each entry of `tenancy.tenants` becomes a `TenantRecord` through `tenantRecord`. The schema refuses keys not listed here.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `tenancy.tenants[].id` | string | required | `^[a-z0-9_-]{1,64}$` | Tenant id |
| `tenancy.tenants[].slug` | string | the id | non-empty | Slug for URLs and subdomains |
| `tenancy.tenants[].name` | string | the id | non-empty | Display name |
| `tenancy.tenants[].state` | string | `'active'` | `'provisioning'`, `'active'`, `'suspended'`, `'deleting'`, `'deleted'` | Tenant state; only `'active'` is admitted |
| `tenancy.tenants[].domains` | string[] | `[]` | non-empty strings | The tenant's own host names; lower-cased |
| `tenancy.tenants[].placement` | object | none | `{ kind: 'schema', schema: string }`, both required | Where the tenant's data lives; stored, not read by this package |
| `tenancy.tenants[].settings` | object | `{}` | any object | Free-form settings; stored, not read by this package |

```ts
tenancy: {
  registry: 'ConfigTenantRegistry',
  access: 'PrincipalAttributeTenantAccess',
  registryCacheMs: 5000,
  tenants: [
    { id: 'acme', slug: 'acme-inc', name: 'Acme Inc', domains: ['shop.acme.example'], settings: { plan: 'pro' } },
    { id: 'globex', name: 'Globex', state: 'suspended', placement: { kind: 'schema', schema: 't_globex' } },
  ],
},
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Configuration values | `Configuration` (`@spinajs/configuration`) | your configuration sources | a `FrameworkConfiguration` subclass, config files, other sources | See [`@spinajs/configuration`](../configuration/README.md) |
| `TenantRegistry` selected by `tenancy.registry` | named registrations under `TenantRegistry` | `ConfigTenantRegistry` | `MemoryTenantRegistry` | See [Tenant registries](03-tenant-registries.md#services-and-extension-points) |
| `TenantAccess` selected by `tenancy.access` | named registrations under `TenantAccess` | `PrincipalAttributeTenantAccess` | none shipped | See [Tenant admission and access](04-admission-and-access.md#services-and-extension-points) |

### Settings from code

An app that builds its configuration in code returns the `tenancy` section from `onLoad()`.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

export class TenancyAppConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      tenancy: {
        registry: 'MemoryTenantRegistry',
        registryCacheMs: 0,
      },
    };
  }
}

DI.register(TenancyAppConfiguration).as(Configuration);
```

## Important behaviour

- A `tenancy.registry` or `tenancy.access` that is not a string, or names no registered class, throws `InvalidOption` on the first `tenantRegistry()`, `tenantAccess()`, `admitTenant()` or `forEachTenant()` call in a container.
- A `state` outside the list also throws `InvalidOption` from `ConfigTenantRegistry` when it parses the list, rather than reading the tenant as active.
- `TENANCY_DEFAULTS` holds the code defaults; it is not merged into the configuration, so `Configuration.get('tenancy.registry')` stays `undefined` when unset.
- `DI.clearCache()` drops the schema registration made at import; the module's top level does not run again in the same process.

## Best practices

- List tenants under `tenancy.tenants` only for a fixed, small set; use a custom [`TenantRegistry`](03-tenant-registries.md#tenantregistry-custom-implementation) for tenants created at run time.
- Set `tenancy.registryCacheMs` to `0` in tests that change a cacheable registry, or call `invalidate()` between steps.
- Read `TENANCY_DEFAULTS` instead of repeating the default values in your code.

## Patterns and antipatterns

```ts
// Don't: 'disabled' is not a tenant state; the schema and ConfigTenantRegistry refuse it
tenancy: { tenants: [{ id: 'acme', state: 'disabled' }] }

// Do
tenancy: { tenants: [{ id: 'acme', state: 'suspended' }] }
```

## Examples

### Read the effective tenancy settings at startup

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { TENANCY_DEFAULTS } from '@spinajs/tenancy';

export async function logTenancySettings(): Promise<void> {
  const cfg = await DI.resolve(Configuration);
  const registry = cfg.get<string>('tenancy.registry') ?? TENANCY_DEFAULTS.registry;
  const cacheMs = cfg.get<number>('tenancy.registryCacheMs') ?? TENANCY_DEFAULTS.registryCacheMs;
  console.log(`tenant registry ${registry}, cached for ${cacheMs} ms`);
}
```

## Related

- [`@spinajs/configuration`](../configuration/README.md): sources, merging, schema validation and named services.
- [`@spinajs/tenancy-http`](../tenancy-http/README.md): the reader of `tenancy.http.*`.
- Every feature page lists the keys it reads.
