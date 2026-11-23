---
'@spinajs/queue': minor
---

`queue.outbox` configuration and the `queue_outbox` table, created once per database named in `queue.outbox.connections` when `queue.outbox.enabled` is true. The values are validated at boot; a duration is a whole number of milliseconds or a string with a unit; an unknown key under `queue.outbox` is dropped, not refused. Off by default; nothing writes to the table yet.
