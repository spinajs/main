---
"@spinajs/authz-ir": patch
---

`IREvaluator` no longer lets a ceiling's `roles` lift a deny: a role relation read on a deny side (the subtract of an exclusion, a `then: 'deny'` entry of a priority chain) counts whatever the ceiling lists, as the RBAC engine counts every deny role. A principal with `ceiling: { roles: ['editor'] }` who also holds a deny role was answered `allow`; it is `deny` now.
