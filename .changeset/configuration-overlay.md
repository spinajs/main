---
"@spinajs/configuration-common": minor
"@spinajs/configuration": minor
---

`ConfigurationOverlay`: a registered overlay answers the configuration reads it covers with the values of the current unit of work (a tenant), laid over the merged tree; `Configuration.isOverlaid(path)` tells whether a path is covered. `ScopedConfigurationSource` holds values per scope for an overlay to read. `FrameworkConfiguration.check(path, value)` runs the schema check of `set()` without writing. Without a registered overlay nothing changes.
