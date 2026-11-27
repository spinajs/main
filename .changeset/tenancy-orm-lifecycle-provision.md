---
"@spinajs/tenancy-orm": minor
---

`TenantLifecycle` (`DefaultTenantLifecycle`): `provision()` of a row-mode tenant in resumable steps with `TenantSeeder`s, one operation per tenant at a time under the lease of the tenant's row, measured in database time (`DbClock`); a seeder's error names the seeder. `migrate()` answers `skipped` for a tenant without a schema; `suspend()`, `resume()`, `export()` and `delete()` reject with `NotSupported` until their branches.
