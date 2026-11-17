---
"@spinajs/authz": patch
"@spinajs/authz-http": patch
---

`AuthzService.audit()` drops an entry of a kind the domain turns off (`authz.audit.denials`, `runAs`, `unscoped`), as the engine drops its own. The `deny` entry the decisions route writes for a replay of another domain names the refused permission (`authz.http.decisionsRoute.permission` on its type-level resource), not the replayed record's permission; the record appears by id in the reason.
