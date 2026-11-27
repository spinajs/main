---
"@spinajs/authz-orm": major
---

The domain boot refuses two `@AccessResource` types whose classes map to one table, with an `AuthzConfigError` that names both classes, both types and the table. Such a table was never kept right: a write rewrote the links of the written class's type only, so a move of a row through a class of one type left the row's links of the other type at the old parent (a grant on the old parent still reached the row), and authz:ancestors-rebuild wrote every row as both types. Register every class of a table under one resource type, or map each type to a table of its own. Several classes of one type on one table, and one type over several tables, still boot. A class registered after the boot is refused at its first use: every query and write of both types on that table then throws. Table names are compared without case. The package's CLI commands (`authz:ancestors-rebuild`, `authz:ancestors-verify` and the others) refuse such a registry too.
