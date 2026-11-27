---
"@spinajs/tenancy": minor
---

`@spinajs/tenancy`: with `tenancy.access` unset, the access check is `AuthzTenantAccess` when one is registered (by importing `@spinajs/tenancy-orm/authz`), else `PrincipalAttributeTenantAccess` as before.
