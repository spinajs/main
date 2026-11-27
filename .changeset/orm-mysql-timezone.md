---
"@spinajs/orm-mysql": minor
"@spinajs/orm": minor
---

MySQL connections take a `TimeZone` option that sets one zone for the session, for mysql2, for the datetime text the converter writes and reads, and for `driver.now()` / `driver.ago()`. Without it a connection runs in UTC, as every 3.x release did (`SET time_zone = '+00:00'`, mysql2 `timezone: 'Z'`, `UTC_TIMESTAMP(3)`), so rows a 3.x application stored read back unchanged. `SYSTEM` keeps the server's zone and stores the wall clock of the node process (as 2.x did); every node process and the MySQL server must then run in one zone. An offset such as `+02:00` applies to every layer, and a named zone fails the driver resolve with `OrmException`.
