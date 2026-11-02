---
"@spinajs/authz": major
"@spinajs/authz-rbac": major
"@spinajs/authz-abac": major
---

Only `authz.models` (root) and `authz.domains.<name>.models` activate authorization models, by the class name, or factory function name, they are registered under `AuthorizationModel` with. Root without `authz.models` has no model: it boots, every check denies with `no_access`, and the host logs the registered names. `RbacModel` and `AbacModel` are built by DI per domain; `registerRbac`, `buildRbac`, `useRbac` and the `authz.use` keys are removed. Brought from 3.0.25 (#405).
