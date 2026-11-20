---
"@spinajs/orm": patch
---

The schema diff no longer counts an expression or prefix index (`lower(email)`, MySQL `email(10)`) as the plain index a model declares on that column. Each such index is reported as an info diagnostic `MIG007` ("cannot be compared; check it by hand"), is never dropped as an index `--base` had, and no `addIndex` is proposed for a declared index whose name it holds. `MIG007` is not a change: `migrate-diff --check` keeps exit code 0 when it is the only finding.
