---
"@spinajs/fs": minor
"@spinajs/templates": minor
"@spinajs/intl": minor
"@spinajs/http": minor
---

Configuration schemas for the sections these packages read, so the configuration validates them at boot and `spinajs doctor` no longer reports CFG001 for them. `fs` checks `defaultProvider`, `providers[]` (`name` and `service` required), `middlewareTimeoutMs`, `hasher` and `fileInfo`; `templates` checks `cache.mode`; `intl` checks `defaultLocale`, `locales` and `queryParameter`; the top-level `https` switch must be `true` or `false` (`@spinajs/http` now ships `https: false` as its default). All four roots stay open for options of other packages. Each is exported (`FS_CONFIGURATION_SCHEMA`, `TEMPLATES_CONFIGURATION_SCHEMA`, `INTL_CONFIGURATION_SCHEMA`, `HTTPS_CONFIGURATION_SCHEMA`).
