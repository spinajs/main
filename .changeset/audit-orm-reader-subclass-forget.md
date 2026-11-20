---
"@spinajs/audit-orm": patch
---

`forget(subject)` through a `TableAuditReader` subclass that overrides `table()` or `driver()` away from the trail's table on the trail's connection erases where they point only, instead of also blanking the trail table on every other connection behind the subclass's back.
