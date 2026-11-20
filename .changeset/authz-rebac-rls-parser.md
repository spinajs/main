---
"@spinajs/authz-rebac": patch
---

`rebac.rls` checks its term before rendering it: `parseRebacRlsExpr(args)` refuses a node that is not `tuples`, `arrow`, `any` or `all`, an unknown key and an empty name with an `AuthzConfigError` that names the path, instead of rendering whatever it was handed.
