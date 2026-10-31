---
"@spinajs/configuration": patch
---

A schema with no defaults no longer stores an empty object at an unset path when another schema over that path refuses an empty section. That schema judged a section nobody set, so the same tree passed or failed by check order, and `Configuration.set()` under `authz` failed on `authz.admin.guard.privilegedPermission` once a boot had filled `authz.admin.guard` with `{}`.
