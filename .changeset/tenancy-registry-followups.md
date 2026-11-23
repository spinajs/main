---
"@spinajs/tenancy": patch
---

`forEachTenant()`: when the registry fails while listing, no further tenant is started, and the call rejects only after the tenants already started have finished.

`ConfigTenantRegistry`: an id, a slug or a domain (compared lower-cased) listed for two entries of `tenancy.tenants` is refused with `InvalidOption` instead of the first entry winning.
