---
'@spinajs/manifest': minor
'@spinajs/orm': minor
'@spinajs/compiler': minor
'@spinajs/orm-postgres': minor
'@spinajs/orm-mysql': minor
'@spinajs/orm-sqlite': minor
'@spinajs/orm-mssql': minor
---

ORM drivers declare what their database hands back to raw SQL with `@SqlDialect(profile)`; `spinajs build` records the profile in the driver's manifest fragment (`sqlDialects`).
