---
"@spinajs/tenancy-http": minor
---

`@spinajs/tenancy-http`: `TenantMiddleware` (stage `beforePolicy`) resolves the tenant of a request, checks it against the registry and `TenantAccess`, and sets the tenant scope for the policies, the action and the reply hooks; list it in `http.routes.middlewares` to require a tenant on every route. `@TenantRoute()`, `@NoTenant()` and `@AllTenants(reason)` declare a route's or a controller's tenancy; the route's wins. An unknown, inactive or forbidden tenant, or none at all, answers 404 with the code `tenant.unavailable` (`tenancy.http.unknownTenant: 403` for 403).
