---
"@spinajs/tenancy": patch
---

`@spinajs/tenancy/queue` loaded alone admits tenants: the hook imports what it needs through the package entry, which registers the tenant registries and the default tenant access check. A consumer process that imported only the subpath refused every message of a tenant with `no TenantRegistry is registered`, retried until it dead-lettered.
