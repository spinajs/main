---
"@spinajs/tenancy": minor
---

`@spinajs/tenancy/fs`: the providers listed in `tenancy.fs.prefixed` keep each tenant's files under `tenancy.fs.prefix` (default `tenants/${tenant}/`), or on a provider of the tenant's own (`tenancy.fs.dedicated`). Middlewares see the application's paths; an action outside a tenant scope, or across all tenants, throws `TenantRequired`; no path, absolute path or symbolic link reaches another tenant's files, and inside a tenant an action on a listed provider's shared files (`publishedFs()`) or an unzip into the tenant's whole root is refused. A listed provider that `@spinajs/authz-fs` guards (`authz.fs.<name>.mode` `audit` or `enforce`), that `@spinajs/upload`, email templates, log targets or a temporary file system use, a dedicated provider that is listed or shared, and a provider layer registered after the tenant's are refused with `InvalidOption`; keep files that need file ACLs on a provider that is not listed. `@spinajs/fs` is an optional peer.
