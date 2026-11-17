---
"@spinajs/compiler": minor
---

`spinajs doctor` reports the flow findings of the app's own package: `AUTHZ001` (unscoped multi-row read of an access resource), `AUTHZ002` (unscoped update or delete builder) and `AUTHZ006` (`runAs(SYSTEM)` without a literal reason), each with its call path. `// spinajs-authz-ignore <code>: <reason>` on the line of the query, or the line above, silences one. Warnings in 4.x.
