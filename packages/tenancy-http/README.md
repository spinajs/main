# `@spinajs/tenancy-http`

Finds the tenant of an HTTP request or a socket handshake of a SpinaJS application.

- `tenancy.http.resolvers` lists where a tenant is read from; the first proposal wins: `domain`, `subdomain` (both need `tenancy.http.baseDomains`), `path` (route parameter `tenant`), `header` (`x-tenant`, honoured only for an authenticated principal), `principal` (attribute `tenant`), `session` (key `tenant`).
- An application's own source is a `TenantResolver` registered as `<Name>TenantResolver` and listed as `<name>`.
- `resolveTenant(resolvers, source)` answers the tenant, once it is known to the registry, active, and open to the principal (`TenantAccess`).
