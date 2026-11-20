---
"@spinajs/authz": patch
---

`AuthzService.audit()` keeps its "never throws" contract on a service that is not resolved or is disposed: the entry is dropped with a warning.
