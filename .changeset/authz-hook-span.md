---
"@spinajs/authz": minor
---

The `authz.check` span now encloses the `authz.check` action hook, so a hook-narrowed deny is recorded as `spina.authz.allowed=false` with `spina.authz.reason=hook:<code>`. `Authorizer.check` takes an optional `narrow` callback that runs inside the span.
