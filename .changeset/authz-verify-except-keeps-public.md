---
"@spinajs/authz-verify": patch
---

An exception of `isolated(type)` or a holder of `onlyVia` that names a relation or a role (`tenant#member`, `role:member`) selects the named holders of that relation only, no longer its public tuples (`user:*`). A policy that passed with such a selector while the same relation also grants public access now fails `spinajs authz:verify` with `AZV001` (exit 1) and a counterexample naming the wildcard tuple. Review that public grant; where it is intended, add `'public'`, or `public:<type>#<relation>` for that relation, to the exceptions or holders. `never` is unchanged.
