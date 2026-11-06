---
"@spinajs/tasks": patch
---

The task history cleanup event is built with the query builder and `driver.ago(7, 'day')`, on the same clock as `driver.now()`. On MySQL that is `(UTC_TIMESTAMP(3) - INTERVAL 7 DAY)`. There is no behaviour change on existing databases: an applied migration keeps its old event body (`NOW() - INTERVAL 7 DAY`, already UTC because the driver sets the session time zone to `+00:00`); only new installs get the new body.
