---
"@spinajs/orm": minor
"@spinajs/authz-orm": patch
---

`InStatement` has the accessors `Column`, `Values` and `Not`, as `WhereStatement` has `Column`, `Operator` and `Value`. authz-orm's access guard reads them instead of casting to the statement's protected fields. No behaviour change. The protected field `InStatement._val` is typed `unknown[]` instead of `any[]`.
