---
"@spinajs/authz-orm": patch
---

`@spinajs/authz-orm`: `authz:ancestors-rebuild` reads each table through a class of the type that declares `@Parent`. When two classes of one type map to one table and the first one registered declares no `@Parent`, the rebuild used to read the table through that class, find no parents and delete every ancestor link of the type, and `authz:ancestors-verify` reported the right links as extra. The rebuild now writes the links the writes leave.
