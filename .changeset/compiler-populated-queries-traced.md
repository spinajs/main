---
"@spinajs/compiler": patch
---

Queries that call a typed `populate()` are followed again. Since `populate()` narrows the relation it loads, its rows are typed as `Post & { Owner: … }`, and the compiler did not see the model in that intersection. The N+1 check (`ORM101`, `ORM102`) skipped every populated query; it checks them now, so a build may report warnings (errors in a strict package) that were missing before. The authorization flow pass read `populate(…).first()` as a multi-row read; it is a single-row read now, so such a site no longer counts in `authz.flow.foreignModelQueries` and can no longer be reported as `AUTHZ001`. An intersection of two different models still names no model.
