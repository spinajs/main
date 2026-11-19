---
"@spinajs/orm-sql": patch
---

The `db.query` span of a streamed select records the error type and an ERROR status when the cursor fails to close.
