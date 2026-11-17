---
"@spinajs/authz-orm": major
---

`AncestorMiddleware` is removed: `AncestorObserver`, a `WriteObserver` on the ORM write capture, keeps `authz_resource_ancestor` right instead, sharing the capture's reads with the column changelog (one key select per write instead of two, and no `stillThere` read after a delete). An upsert that updates a row through a unique column now moves that row. Every `@AccessResource` model with a composite primary key is refused at domain boot.
