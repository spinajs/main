---
"@spinajs/intl": patch
"@spinajs/validation": patch
"@spinajs/orm": patch
---

`glob` is imported when a translation, schema or migration directory is first listed instead of when the package loads, so a boot that lists none of them, such as a `require`-mode boot whose migrations come from the manifest, does not load it. `LoadJSONSchema` called before `LoadJSSchema` loads `glob` itself, and fails with an `InvalidOperation` naming that cause when it is not installed.
