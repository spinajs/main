---
"@spinajs/orm-mysql": minor
---

`MysqlServerResponseMapper.insertedKeys()` reports the keys of inserted rows by MySQL's own rule instead of the core default, and does not read `insertIdIsFirstOfBatch`. A key is reported only for a single-column `auto` primary key whose column is `AUTO_INCREMENT`. One row gets `insertId` when the OK packet proves the statement wrote it: an `INSERT` or `INSERT IGNORE` that inserted it, a `REPLACE`, or an `ON DUPLICATE KEY UPDATE` that inserted or updated it; a skipped or unchanged row and `INSERT IGNORE ... ON DUPLICATE KEY UPDATE` report none. A plain multi-row insert walks the block from `insertId` by the connection's `auto_increment_increment` (`first + k * step`, where the core rule assumed a step of 1), under the same guards as before.

Each pooled connection turns on the server's session tracker for `auto_increment_increment` when it opens (one `SET`, new protected `trackAutoIncrementStep(pool)`), and the driver keeps the step current from the OK packets of the statements that change it. Insert responses carry it as `AutoIncrementStep`. Where the step is unknown (no session tracking on the server, `SESSION_TRACK` dropped from `Options.flags`, a failed `SET`) a multi-row insert reports no keys.
