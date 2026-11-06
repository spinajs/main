---
"@spinajs/tasks": patch
---

The task history cleanup event deletes rows older than `driver.ago(7, 'day')`. On MySQL that is `UTC_TIMESTAMP(3) - INTERVAL 7 DAY`: the old `NOW() - INTERVAL 7 DAY` compared the UTC-stored `CreatedAt` with the server's local time.
