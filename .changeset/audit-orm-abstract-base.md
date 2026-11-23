---
"@spinajs/audit-orm": minor
---

`@Auditable()`, `registerAuditable` and `auditOf` take an abstract model class too, typed `ModelBaseClass` of `@spinajs/orm`. A mark on an abstract base covers its concrete subclasses, each reading the events of its own table; the mark still needs the merged row interface and the `declare static audit` line.
