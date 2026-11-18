---
"@spinajs/tenancy": patch
---

`forEachTenant()`: when the registry fails mid-run, the call now rejects with the new `TenantIterationAborted` instead of the registry's error. The registry's error is its `cause`, and its `report` holds the result of the tenants that ran before the failure, in the shape the resolved call returns. As before, no tenant starts after the failure, and the call rejects only once the started tenants have finished.
