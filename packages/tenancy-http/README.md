# `@spinajs/tenancy-http`

Finds the tenant of an HTTP request or a socket handshake of a SpinaJS application.

- `tenancy.http.resolvers` lists where a tenant is read from; the first proposal wins: `domain`, `subdomain` (both need `tenancy.http.baseDomains`), `path` (route parameter `tenant`), `header` (`x-tenant`, honoured only for an authenticated principal), `principal` (attribute `tenant`), `session` (key `tenant`).
- An application's own source is a `TenantResolver` registered as `<Name>TenantResolver` and listed as `<name>`.
- `resolveTenant(resolvers, source)` answers the tenant, once it is known to the registry, active and, for an authenticated principal, open to it (`TenantAccess`); an anonymous request is admitted on a trusted source.
- Behind a proxy, the host is the first `X-Forwarded-Host` value only when `http.trustProxy` trusts the peer; otherwise the `Host` header.
