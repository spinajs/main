---
"@spinajs/orm-mysql": patch
---

The dedicated connection of the migration lock runs in the configured session zone, as the pooled connections do: it sends `SET time_zone` for a `TimeZone` other than `SYSTEM`, and opening it fails when the `SET` fails.
