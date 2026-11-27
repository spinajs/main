---
"@spinajs/authz-verify": patch
---

`isolated(type)` counts public grants (`user:*`): a resource of another tenant that everyone may reach is now `violated`; declare intended public access with `isolated(type, { except: ['public'] })`.
