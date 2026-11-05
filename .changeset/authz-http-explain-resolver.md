---
"@spinajs/authz-http": minor
---

`resolveExplainRequest({ principal, permission, resource? })` turns the `<type>:<id>` keys of an explain call into the `DecisionRequest` that `AuthzService.explain()` takes. `GET /authz/explain` uses it unchanged; Spina Studio shares it, so both resolve principals and resources alike.
