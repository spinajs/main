---
"@spinajs/tenancy-orm": patch
---

`TenantStateService.transition(id, 'active')` and `row.writeSuspension('active', null)` throw `InvalidOperation` (it no longer answers `false`) for a tenant whose lifecycle record names a deletion or cannot be read, with the refusal `resume()` gives ("the deletion of tenant ... started at ...; a deletion is finished, not resumed"), so a tenant whose data is being removed is never admitted again. A move to `active` through `transition` clears the suspension record, as `resume()` does.
