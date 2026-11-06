---
"@spinajs/authz-orm": minor
"@spinajs/authz-rbac": minor
---

`.withFields(permission)` gives each row of a select its own field set for `redact()`: the plan's permit and deny terms, split into atoms by `PlanTermCompiler.atoms()`, and its `within` ceiling become CASE columns (as `.withAccess()` does), rows matching the same atoms form one group, and one batched `checkAll` decides one row per group. Never one check per row; a `none` plan gives every row no field without a decision. Under a `fields: 'filter-rows'` route or socket command (`AuthzRowFields`), an `.accessible(p)` select gets `.withFields(p)` on its own. `RbacAssignmentTerm.atoms()` splits a term into one atom per role entry, so rows reached by different roles never share a field set.
