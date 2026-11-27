---
"@spinajs/authz-orm": major
---

The domain boot refuses two `@AccessResource` types whose classes map to one table, with an `AuthzConfigError` that names both classes, both types and the table. Such a table was never kept right: a write rewrote the links of the written class's type only, and `authz:ancestors-rebuild` wrote every row as both types, so after a rebuild a move through one class left the other type's links at the old parent (a grant on the old parent still reached the row). Register every class of a table under one resource type, or map each type to a table of its own. Several classes of one type on one table, and one type over several tables, still boot.
