---
"@spinajs/tenancy-orm": minor
---

`@spinajs/tenancy-orm/authz`: the resource type `tenant` in authz. The package ships the permissions `tenant:enter`, `tenant:members.add`, `tenant:members.remove` and `tenant:settings.manage` and the roles `tenant.member`, `tenant.admin` and `tenant.owner` as configuration. `AuthzTenantAccess` lets a principal enter a tenant when it holds `tenant:enter` there, and `tenantsOf(principal)` lists the active tenants it may enter. `@spinajs/authz` and `@spinajs/authz-orm` are optional peers.
