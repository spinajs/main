---
"@spinajs/tenancy": minor
---

`@spinajs/tenancy`: with `tenancy.access` unset, the access check is `AuthzTenantAccess` when one is registered (by importing `@spinajs/tenancy-orm/authz`), else `PrincipalAttributeTenantAccess` as before. With it, `SYSTEM` enters every tenant, and a role whose grants match `tenant:enter` by glob (`*`, `tenant:*`, `*:enter`) gives entry wherever it is held: at `$global`, every tenant. Narrow such roles or deny `tenant:enter`.
