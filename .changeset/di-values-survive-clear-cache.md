---
"@spinajs/di": major
---

Values bound with `asValue` / `asMapValue` are registrations: `clearCache()` no longer drops them, `clearRegistry()` and `clear()` do. Code that re-registered a value after `clearCache()` can stop doing so.

`uncache(key)` removes a value as well; `asValue(key, true)` also drops an instance already cached under `key` in that container.
