---
"@spinajs/tenancy": patch
---

`forEachTenant()`: when the registry fails while listing, no further tenant is started, and the call rejects only after the tenants already started have finished.
