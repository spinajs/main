---
"@spinajs/compiler": patch
---

Queries that call a typed `populate()` are followed again. Since `populate()` narrows the relation it loads, its rows are typed as `Post & { Owner: … }`, and the compiler did not see the model in that intersection: the N+1 check (`ORM101`, `ORM102`) and the authorization flow pass skipped every populated query. They are checked now, so a build may report warnings (and, in a strict package, `ORM101`/`ORM102` errors) that were missing before. An intersection of two different models still names no model.
