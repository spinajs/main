---
"@spinajs/authz-orm": patch
---

`@spinajs/authz-orm`: `authz:ancestors-rebuild` can run while the application writes. Each type's transaction locks the resource tables it reads and `authz_resource_ancestor` against writes before it reads the `@Parent` columns. It then checks again for links to types no `@Parent` names. A move, insert or delete that arrives meanwhile waits for the rebuild and then runs on the rebuilt rows. Before, a moved row could keep its old parent's links, the move could fail with a duplicate key, and a link written after the check was dropped. An authorization check never waits on PostgreSQL and MySQL; on SQLite in one process and on MSSQL it does. On PostgreSQL a rebuild that cannot take its locks within 5 s fails that type and changes nothing, so writers do not queue behind it.
