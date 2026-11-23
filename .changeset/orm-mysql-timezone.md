---
"@spinajs/orm-mysql": major
"@spinajs/orm": minor
---

MySQL connections take a `TimeZone` option that sets one zone for the session, for mysql2, for the datetime text the converter writes and reads, and for `driver.now()` / `driver.ago()`: `SYSTEM` (default) keeps the server's zone and expects the node process to run in the same one, `UTC` keeps the former always-UTC behaviour, an offset such as `+02:00` applies everywhere, and a named zone fails the resolve. Breaking: connections no longer default to UTC sessions; set `TimeZone: 'UTC'` to keep the previous behaviour. Datetimes written under the old UTC default read back shifted by the server's offset under the new default unless `TimeZone: 'UTC'` is set.
