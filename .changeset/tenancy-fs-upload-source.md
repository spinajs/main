---
"@spinajs/tenancy": patch
---

`@spinajs/tenancy/fs`: inside a tenant, an `upload()` into any provider (also one that is not listed, or `fs-temp`) whose local source lies in another tenant's files or in a listed provider's shared files is refused with `InvalidArgument`.
