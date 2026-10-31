---
"@spinajs/configuration": patch
---

A schema with no defaults under another schema's module no longer stores an empty object at an unset path. The parent schema judged that empty section, so the same tree passed or failed by check order, and `Configuration.set()` under `authz` failed on `authz.admin.guard.privilegedPermission` once a boot had filled `authz.admin.guard` with `{}`.
