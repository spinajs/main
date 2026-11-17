---
"@spinajs/authz-orm": minor
---

The relation-column changelog is a `WriteObserver` (`ColumnChangeObserver`) on the ORM write capture instead of its own query middleware; it writes the same `authz_change_log` rows. When the same write is also captured by another observer (such as `@spinajs/orm-history`), the rows are read once. `SystemCaptureReadScope` runs the capture's key select as SYSTEM.
