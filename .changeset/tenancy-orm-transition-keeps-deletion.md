---
"@spinajs/tenancy-orm": patch
---

`TenantStateService.transition(id, 'active')` and `row.writeSuspension('active', null)` refuse a tenant whose lifecycle record names a deletion (`InvalidOperation` "the deletion of tenant ... started at ...; a deletion is finished, not resumed", the refusal `resume()` gives), so a tenant whose data is being removed is never admitted again. A move to `active` through `transition` clears the suspension record, as `resume()` does.
