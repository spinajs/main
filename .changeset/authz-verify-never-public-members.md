---
"@spinajs/authz-verify": patch
---

`never(holder, permission)` with a holder that names a relation or a role (`tenant#member`, `role:member`) counts a public member of that relation (`user:*`) as one of its holders in the exact engine too, as the bounded search already did. A policy that passed `never(<relation or role>, <permission>)` while that relation's members were public, so that everyone held the permission through it, now fails `spinajs authz:verify` with `AZV001` (exit 1) and a counterexample naming the wildcard tuple. Remove the public grant, or drop the assertion if public access is intended. `accessOf(matrix, holder, permission)` reads the same way: the cells of the public holder of that relation count for it.
