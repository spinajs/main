---
"@spinajs/tenancy-orm": minor
---

The migration `Tenants_2026_12_01_00_00_00` adds the lifecycle columns to `tenants` (`lifecycle`, `suspension` and a fenced lease: `lifecycle_owner`, `lifecycle_until`, `lifecycle_epoch`), read with `lifecycleOf()` and `suspensionOf()`. The package now depends on `@spinajs/durable`.
