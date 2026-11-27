---
"@spinajs/authz-verify": patch
---

`@spinajs/authz-verify`: `isolated(type)` also searches the permissions whose resource is an object of `type` itself (`tenant:enter` for `isolated('tenant')`); they were reported `holds` without a search.
