# `@spinajs/tenancy-http`

Finds the tenant of an HTTP request or a socket handshake of a SpinaJS application.

- `tenancy.http.resolvers` lists where a tenant is read from; the first proposal wins: `domain`, `subdomain` (both need `tenancy.http.baseDomains`), `path` (route parameter `tenant`), `header` (`x-tenant`, honoured only for an authenticated principal), `principal` (attribute `tenant`), `session` (key `tenant`).
- An application's own source is a `TenantResolver` registered as `<Name>TenantResolver` and listed as `<name>`.
- `resolveTenant(resolvers, source)` answers the tenant, once it is known to the registry, active and, for an authenticated principal, open to it (`TenantAccess`); an anonymous request is admitted on a trusted source.
- Behind a proxy, the host is the first `X-Forwarded-Host` value only when `http.trustProxy` trusts the peer; otherwise the `Host` header.

## Routes

- Turn tenancy on for every route with `http.routes.middlewares: ['TenantMiddleware']`. A route then needs a tenant unless it says otherwise, and its policies, action and reply hooks run in that tenant's scope.
- `@TenantRoute()`, `@NoTenant()` and `@AllTenants(reason)` declare a route's or a controller's tenancy; the route's wins.
- List `TenantMiddleware` first in `http.routes.middlewares`: a `beforePolicy` middleware that answers before it does so without a tenant scope.
- An `@AllTenants` route runs for any caller, anonymous included: guard it with its own policy.
- A request that names no tenant, or one that is unknown, not active or closed to the principal, is answered 404 (`tenancy.http.unknownTenant: 403` for 403) with the code `tenant.unavailable` and the same body in every case.

## Sockets

`import '@spinajs/tenancy-http/socket'` (needs `@spinajs/http-socket`) gives a socket connection one tenant for its life. It is resolved once, in the handshake, with the same resolvers; a browser names its tenant with `io(url, { auth: { tenant } })`, which counts as the header. A handshake that names no tenant connects with no tenant scope; one that names a tenant it may not have is refused. The tenant is not checked again while the connection lives: suspending a tenant refuses its new connections, not the open ones.
