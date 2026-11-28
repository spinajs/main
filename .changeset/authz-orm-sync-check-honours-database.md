---
"@spinajs/authz-orm": patch
---

The check after a filtered `sync()` now counts the rows left in the database its statement names. A `sync()` callback that points the orphan delete or the soft-delete stamp at another database (`if (this instanceof DeleteQueryBuilder) this.database(name)`) used to be checked against the model's own database: a sync that removed every allowed orphan there could be refused with `AccessDenied`, and one that left a denied orphan behind could commit. A `sync()` that names no database is checked exactly as before.
