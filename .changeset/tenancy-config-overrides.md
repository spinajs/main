---
"@spinajs/tenancy": minor
---

A tenant overrides the configuration paths listed in `tenancy.config.overridable`: inside its scope `Configuration.get` answers the values of its `settings` for them, as the configuration schema accepted them (`TenantConfigurationOverlay`). A listed path under a closed root (`tenancy`, `db`, `authz`, `authn`, `audit`, `fs`, `system`, `process`, `configuration`, `configuration_db_source`, `https`, `logger`, `telemetry`, `otel`, `cache`) or with a `__proto__`, `constructor` or `prototype` segment fails the boot; a stored value at a path that is not listed is never served. `admitTenant()` and `forEachTenant()` load the tenant's settings into the process; `loadTenantSettings()` does it for code that enters a tenant without an entry point, and a read of an overridable path for a tenant not loaded throws `TenantSettingsUnavailable`. `checkTenantSettings()` validates settings against the configuration schema. Without overridable paths nothing changes.
