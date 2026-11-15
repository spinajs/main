---
"@spinajs/authz-testing": minor
---

`rlsConformance()` is the R3 kit for row level security: on random worlds it compares, per principal and permission, the rows `.accessible()` returns with the rows a raw `SELECT` returns under the generated policies and the principal's session settings, `'equal'` or `'superset'` where the policy is documented to widen (`rls: 'partial'`, ceilings, bare-type ancestor assignments). A failure names the rows, the world and the fast-check seed. `rlsMismatch()` is the comparison alone. authz-rbac and authz-rebac run it against Postgres.
