# Configuration

Every `tenancy.http.*` key: which resolvers run and in what order, what they read, and how a refusal is answered. HTTP routes and sockets read the same keys.

## How it works

1. `@spinajs/tenancy` registers the `tenancy.*` configuration schema (`TENANCY_CONFIGURATION_SCHEMA`) when it is imported, so the configuration is validated at boot.
2. Each service reads its keys with `@Config(key, { defaultValue })`, the defaults coming from `TENANCY_DEFAULTS.http`.
3. The resolver chain is read when it is built: per route at startup for HTTP, at the first handshake for sockets.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `tenancy.http.resolvers` | string[] | `['domain', 'subdomain', 'path', 'header', 'principal', 'session']` | non-empty names; each `x` must be a `TenantResolver` registered as `XTenantResolver` | The resolver chain, asked in order; the first proposal decides. An empty list proposes nothing, so every route that requires a tenant is refused |
| `tenancy.http.baseDomains` | string[] | `[]` | non-empty host names, any case | The application's own domains. A host one label below one of them is a slug for `subdomain`; any other host that is not one of them is a tenant domain for `domain`. Empty: `domain` and `subdomain` propose nothing |
| `tenancy.http.pathParam` | string | `'tenant'` | a non-empty route parameter name | The route parameter `path` reads as a slug |
| `tenancy.http.header` | string | `'x-tenant'` | a non-empty header name, any case | The header `header` reads as a tenant id; on sockets, `auth.tenant` stands in for it |
| `tenancy.http.principalAttribute` | string | `'tenant'` | a non-empty attribute name | The attribute of an authenticated principal `principal` reads as a tenant id |
| `tenancy.http.sessionKey` | string | `'tenant'` | a non-empty key | The key of the restored session data `session` reads as a tenant id |
| `tenancy.http.unknownTenant` | number | `404` | `404`, `403` | The status of `TenantRefused`; on sockets, `403` refuses with `forbidden`, `404` with `not_found` |

Keys this package reads from other packages:

| Key | Owner | Meaning here |
| --- | --- | --- |
| `http.routes.middlewares` | `@spinajs/http` | `'TenantMiddleware'` there requires a tenant on every route without a declaration |
| `http.trustProxy` | `@spinajs/http` | Whether `X-Forwarded-Host` counts for the host; see [Client IP and trusted proxies](../http/17-client-ip-and-trust-proxy.md) |
| `authn.http.trustProxy` | `@spinajs/authn-http` | Wins over `http.trustProxy` when set |
| `tenancy.registry`, `tenancy.access`, `tenancy.tenants`, `tenancy.registryCacheMs` | `@spinajs/tenancy` | Where proposed tenants are looked up and who may enter them; see [`@spinajs/tenancy`](../tenancy/README.md) |

```ts
export default {
  http: {
    trustProxy: ['uniquelocal'],
    routes: { middlewares: ['TenantMiddleware'] },
  },
  tenancy: {
    registry: 'ConfigTenantRegistry',
    tenants: [{ id: 'acme', slug: 'acme', domains: ['shop.acme.example'] }],
    http: {
      resolvers: ['domain', 'subdomain', 'header', 'principal'],
      baseDomains: ['app.example.com', 'www.app.example.com'],
      header: 'X-Tenant',
      principalAttribute: 'tenant',
      unknownTenant: 404,
    },
  },
};
```

## Important behaviour

- **Open section.** The schema of `tenancy.http` does not refuse unknown keys: a misspelled key (`basedomains`) passes validation and is ignored.
- **The order is the policy.** The first resolver that proposes decides, and a refused proposal is not passed on. Put the sources you trust most first.
- **`unknownTenant` is two-valued in code too.** Any value other than `403` answers 404.
- **Header names are case-insensitive.** `X-Org` and `x-org` read the same header.

## Best practices

- Set `tenancy.http.baseDomains` before you list `domain` or `subdomain` in the chain, and list every host the application serves itself.
- Drop resolvers you do not use from the chain: a resolver that is not listed cannot name a tenant.
- Keep `http.trustProxy` in line with your proxies; a hop count trusts `X-Forwarded-Host` from any peer.

## Related

- [Tenant resolvers and the request source](01-tenant-resolvers.md): what each key changes in the chain.
- [`TenantMiddleware` and route declarations](02-tenant-middleware.md): `http.routes.middlewares` and `unknownTenant` on routes.
- [Tenant of a socket connection](03-sockets.md): the same keys in the handshake.
- [`@spinajs/tenancy`](../tenancy/README.md): the rest of the `tenancy.*` section.
