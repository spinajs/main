---
"@spinajs/tenancy-orm": minor
---

`TenantSettingsService.set(id, path, value)` and `unset(id, path)` write a tenant's configuration overrides at the paths `tenancy.config.overridable` lists, in the configuration's shape, after `checkTenantSettings` accepted the whole result, and refresh the registry cache and the process's settings snapshot. Paths that are not listed, paths under a closed root, refused values, `NaN` and `Infinity` at any depth, settings that would take more than 65,535 bytes of JSON, a tenant that is `deleting` or `deleted`, and writes for another tenant than the one in scope are refused, and nothing is written. The service does no authorization: the caller authorizes for the tenant and takes its id from the route, never from a request body. In one process the writes of one tenant take turns; two processes that write the same tenant's settings at the same moment can lose one of the two changes.
