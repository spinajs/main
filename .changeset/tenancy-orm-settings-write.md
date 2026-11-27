---
"@spinajs/tenancy-orm": minor
---

`TenantSettingsService.set(id, path, value)` and `unset(id, path)` write a tenant's configuration overrides at the paths `tenancy.config.overridable` lists, in the configuration's shape, after `checkTenantSettings` accepted the whole result, and refresh the registry cache and the process's settings snapshot. Paths that are not listed, paths under a closed root, refused values and writes for another tenant than the one in scope are refused, and nothing is written.
