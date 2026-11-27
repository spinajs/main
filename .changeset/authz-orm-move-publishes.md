---
"@spinajs/authz-orm": patch
---

`@spinajs/authz-orm`: a write that moves `@AccessResource` rows under another `@Parent` (an update, `reparent()`, an upsert) publishes one authz change after its commit, on the bus of the domain `authz.orm.domain` names. The change holds `scope:<type>:<id>` per moved row, or `*` past 1000 rows. Decisions cached through the old parent are dropped on every process the bus reaches, and so is every type-level decision of the domain. Before, they lasted until `authz.cache.ttlSeconds`, which is still the bound when the publish fails or the process stops between the commit and the publish.
