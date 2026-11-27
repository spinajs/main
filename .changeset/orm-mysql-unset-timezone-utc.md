---
"@spinajs/orm-mysql": major
"@spinajs/orm": patch
---

A MySQL connection without `TimeZone` runs in UTC again, as every published 3.x release (3.0.0 to 3.0.29) did: each session gets `SET time_zone = '+00:00'`, `mysql2` reads and writes datetimes as UTC (`timezone: 'Z'`), and `driver.now()` / `driver.ago()` use `UTC_TIMESTAMP(3)`. Against published 3.x this is no change: rows a 3.x application stored read back as the same instants in any process zone. Breaking against earlier 4.0 builds, where an unset `TimeZone` meant `SYSTEM`: a connection that relied on that sets `TimeZone: 'SYSTEM'`. An explicit `TimeZone` behaves as before. `@spinajs/orm`: the doc comment of `IDriverOptions.TimeZone` names the new default.
