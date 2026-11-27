---
"@spinajs/scheduler": major
---

A schedule can have one row per tenant: `__scheduler` is keyed by (`Name`, `Tenant`), `''` for the global instance, and `__scheduler_run` records the `Tenant` of the instance a run belongs to (migration `Scheduler_2026_11_26_00_00_00`, which rebuilds `__scheduler` and keeps every existing row as the global instance). Leases, the occurrence claim, the pause and the failure count belong to one instance; emit-mode job ids of tenant instances come from their own namespace. Breaking: `ScheduleModel` has a composite key, so a look-up or `destroy()` by the name alone no longer addresses one row; filter with `where({ Name, Tenant: '' })`. Stop every scheduler process while the migration runs and start only the new version afterwards (see the upgrade notes).
