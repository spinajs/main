---
"@spinajs/compiler": patch
---

A `spinajs-tenancy-ignore` or `spinajs-authz-ignore` comment is read from its own line only. One without a reason after the colon is not recorded; before, it took the next line of the file as its reason.
