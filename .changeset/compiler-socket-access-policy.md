---
"@spinajs/compiler": patch
"@spinajs/manifest": patch
---

The manifest describes `@SocketAccess` as `@spinajs/http-socket` mounts it: the policy group is `SocketAccessPolicy` with the scope `handler` or `class` (it was `AccessPolicy` with `route`), the `also` policies stay in the group, and the entry point in `authz.entryPoints` carries `unfilteredInput`. `inheritSocketHandlers` and the doctor rules read both names, so a fragment built by an older compiler still merges.
