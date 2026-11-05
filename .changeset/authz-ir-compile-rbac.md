---
"@spinajs/authz-rbac": minor
"@spinajs/authz-ir": minor
---

`rbacToIR` / `RbacModel.toIR` compile RBAC roles into the policy IR: roles become stored relations of their scope types (`$global` without `scopeTypes`), each permission a `can_<permission>` relation along the scope chain, grants with `relation` an intersection, deny roles the deny side. What the IR cannot express (`on`, `requiresTag`, `grantedAt`, implied roles, ladder resource types, rules) is compiled as opaque terms, so the evaluator answers `unknown` there. `IRFragment.defaults` lets a fragment put a relation on every type it does not know.
