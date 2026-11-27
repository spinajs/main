---
"@spinajs/tenancy": patch
---

`@spinajs/tenancy/fs`: a path the tenant view returns (`resolvePath()`, `download()`, `unzip()`) can be passed back to it; it is read relative to the tenant's root instead of being prefixed a second time.
