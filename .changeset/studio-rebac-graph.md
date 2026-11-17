---
"@spinajs/studio": minor
---

Spina Studio answers `GET /_studio/api/authz/namespaces` (the ReBAC schema graph), `GET /_studio/api/authz/tuples` (paged tuples with a total) and `GET /_studio/api/authz/relations/graph?focus=type:id[#relation]&depth&limit` (a breadth-first expansion over stored tuples in both directions, ids in the focus syntax). The `rebac` capability is true when a booted domain has a ReBAC model.
