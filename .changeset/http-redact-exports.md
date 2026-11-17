---
"@spinajs/http": minor
---

The redaction helpers are exported from the package root: `redactFields(value, keys)`, `sensitiveKeyMatcher(keys)`, `REDACTED`, `redactUrl(url)` and `urlPath(url)`. They are what the access log and the error replies already use; packages that record requests import them instead of copying them.
