---
"@spinajs/orm": patch
---

`introspectSchema()` (used by `orm-cli migrate-diff`) now checks whether a table has rows in the database of the connection, as it already read the table's columns, indexes and foreign keys there. Before, the row check ran an unqualified select: on SQLite with `Database` naming an attached database, a table of the same name in `main` or `temp` answered instead. When the attached table had rows and the one in `main` was empty, adding a NOT NULL column without a default was written as a live step and failed when the migration ran; in the reverse layout the step was held back as destructive without need. A connection without `Database` runs the same unqualified select as before.
