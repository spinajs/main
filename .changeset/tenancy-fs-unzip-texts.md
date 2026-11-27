---
"@spinajs/tenancy": patch
---

The `TenantFsGuard` comment and the files-per-tenant page now say that `@spinajs/fs` refuses a whole archive with an entry that resolves outside the destination, and that the refusal of an unzip into a tenant's root is kept as a second check. No behaviour change.
