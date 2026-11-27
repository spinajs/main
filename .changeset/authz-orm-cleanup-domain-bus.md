---
"@spinajs/authz-orm": patch
---

`@spinajs/authz-orm`: the change of a deleted `@AccessResource` row is published on the `ChangeBus` its domain booted with (`authz.bus.service`), as `AuthzAdmin` does, and no longer on the last registered `ChangeBus`.
